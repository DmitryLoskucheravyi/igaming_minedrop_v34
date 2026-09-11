import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CONFIG, serverSeedHash } from '@minedrop/engine';
import type { RoundResult } from '@minedrop/engine';
import { MongoService } from '../db/mongo.service';
import { PlayerStore } from './player-store';
import type { TelegramUser } from '../telegram/init-data';

/* ============================================================
   PLAYERS — стан гравця живе на СЕРВЕРІ.

   Тут навмисно все, що впливає на гроші: баланс, стрік, nonce,
   виграна бонуска. Клієнт цих цифр не тримає — він їх лише показує.
   Якби стрік лічився в браузері, його можна було б накрутити з
   консолі й отримати бонуску за x70 безкоштовно.

   КЛЮЧ — TELEGRAM ID. Гравець більше не «той, хто прислав
   випадковий uuid із localStorage», а той, чий initData підписаний
   ботовим токеном. Відкрив мініапс з іншого пристрою — той самий
   баланс; підмінив id у запиті — підпис не зійдеться.

   СХОВИЩЕ: у процесі — Map, а копія лежить у MongoDB (PlayerStore).
   На старті все зчитується в Map; після кожної зміни, що торкає гроші
   (раунд, поповнення, ротація сида), документ гравця повністю
   перезаписується в БД (fire-and-forget, persist()). MONGO_URL порожній
   -> тільки Map, стан гине з рестартом (dev без БД).

   ГРОШІ ЗВІДКИ БЕРУТЬСЯ: новий гравець отримує CONFIG.startBalance
   (зараз 0) один раз, при заведенні. Далі баланс росте лише через
   депозит (заявка або ручне зарахування в CRM), подарунки колеса та
   реферальні виплати — тобто через місця, які пишуть у лог і мають
   свою ознаку «вже оплачено».

   Автоматичного «дотягування» балансу до стартового більше немає.
   Воно спрацьовувало на будь-якому зверненні гравця (навіть на
   GET /players/me і GET /payments/me) і робило платіжну частину
   непридатною до перевірки: щойно баланс падав нижче найдешевшої
   ставки, гроші з'являлись самі, ще до того, як гравець устигав
   створити заявку.
   ============================================================ */

export interface PlayerRecord {
  telegramId: number;
  username?: string;
  firstName: string;

  balance: number;
  /* Пустих прокрутів поспіль ОКРЕМО по кожній ставці: ключ — номінал
     ставки, значення — довжина серії на ній. Кірка (в т.ч. форсована)
     обнуляє лічильник СВОЄЇ ставки; промах — +1 до нього. Серія на
     ставці 10 не має жодного стосунку до серії на ставці 250, тож
     перемкнути гарантовану кірку на дорожчу ставку неможливо. */
  dryStreaks: Record<number, number>;

  /* Виграна скаттерами, ще не зіграна бонуска.

     Ставка зберігається РАЗОМ із нею і не підлягає зміні. Інакше
     з'являється проста схема: набити скаттери на ставці 10, а
     безкоштовну бонуску зіграти на 5000 — виплата ж рахується від
     ставки поточного раунду. Тому бонуска належить тій ставці, на якій
     її виграли.

     null — виграної бонуски немає. */
  pendingBonus: { bet: number } | null;

  /* РЕФЕРАЛЬНА ПРИВ'ЯЗКА.

     refBy — хто запросив. Ставиться РІВНО ОДИН РАЗ, у момент
     створення запису, і більше ніколи: інакше гравець переписував би
     її на друга щоразу, коли той хоче бонус.

     Дати виплат лежать тут само, а не в запрошувача, і це навмисно:
     подія належить запрошеному (він прийшов, він зробив депозит), а
     виплата — лише її наслідок. Так одна подія не може оплатитись
     двічі, навіть якщо запрошувача колись видалять і заведуть наново. */
  refBy: number | null;
  refJoinPaidAt: number | null;
  refDepositPaidAt: number | null;
  /* Скільки гравець УСЬОГО вніс депозитами, ₽. Потрібно лише для
     реферального порогу, тому рахується накопиченням тут, а не
     перебором заявок: заявки живуть в іншому сервісі, частина
     зарахувань приходить із неопізнаних переказів, і зшивати це на
     кожен запит означало б тримати дві різні відповіді на одне
     питання. */
  refDeposited: number;

  /* КОЛЕСО ЩОДЕННОГО БОНУСУ.
     wheelAt — коли крутили востаннє; null (або 0) означає «жодного разу»,
     і саме за цим упізнається перший, гарантований прокрут.
     freeSpins — подаровані прокрути, які чекають своєї черги. Грають
     вони на фіксованій ставці (WHEEL_FREE_BET), а не на поточній —
     чому саме так, див. коментар до неї. */
  wheelAt: number | null;
  freeSpins: number;

  clientSeed: string;
  serverSeed: string;        // СЕКРЕТ. Ніколи не віддається до розкриття
  serverSeedHash: string;
  nonce: number;

  /** розкриті сиди минулих серій — гравець може перевірити старі раунди */
  revealed: { serverSeed: string; serverSeedHash: string; clientSeed: string; rounds: number }[];

  history: RoundResult[];
  createdAt: number;
  seenAt: number;
}

const HISTORY_LIMIT = 50;

@Injectable()
export class PlayersService implements OnModuleInit {
  private readonly log = new Logger(PlayersService.name);
  private readonly players = new Map<number, PlayerRecord>();
  private store: PlayerStore | null = null;

  constructor(private readonly mongo: MongoService) {}

  async onModuleInit(): Promise<void> {
    const db = await this.mongo.ready();
    if (!db) return;   // dev без БД — MongoService уже попередив у лог
    const store = new PlayerStore(db);
    const rows = await store.loadAll();
    for (const r of rows) this.players.set(r.telegramId, r);
    this.store = store;
    this.log.log(`Завантажено гравців із БД: ${rows.length}`);
  }

  /** Асинхронно скидає гравця в БД (fire-and-forget, помилку лише логуємо). */
  persist(rec: PlayerRecord): void {
    this.store?.save(rec).catch((e) =>
      this.log.error(`не зберігся гравець ${rec.telegramId}: ${(e as Error).message}`));
  }

  /** Перший вхід — заводимо гравця; далі просто знаходимо.
      Пише в БД лише коли справді щось змінилось (створення) — «останній
      вхід» без активності в БД не летить, це надто дрібно. Балансу тут
      не торкаємось: поповнення живе тільки в CRM. */
  /* Хто хоче знати про НОВОГО гравця. Спостерігач, а не прямий виклик,
     бо інакше цей сервіс мусив би знати про реферальну систему, а вона
     вже знає про нього — вийшло б кільце, яке Nest розв'яже хіба
     forwardRef. Тут же напрямок один: гроші за запрошення нараховує
     той, хто про них знає, а гравці лише повідомляють про появу. */
  private readonly created: ((rec: PlayerRecord) => void)[] = [];

  onCreated(fn: (rec: PlayerRecord) => void): void {
    this.created.push(fn);
  }

  /* startParam — стартовий параметр посилання з ПІДПИСАНОГО initData
     (див. TgStart). Потрапляє в запис лише при створенні: далі він уже
     ні на що не впливає. */
  findOrCreate(user: TelegramUser, startParam?: string): PlayerRecord {
    const found = this.players.get(user.id);
    if (found) {
      found.seenAt = Date.now();
      found.username = user.username ?? found.username;
      found.firstName = user.firstName || found.firstName;
      return found;
    }

    const serverSeed = randomBytes(32).toString('hex');
    const rec: PlayerRecord = {
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName,
      balance: CONFIG.startBalance,
      dryStreaks: {},
      pendingBonus: null,
      wheelAt: null,
      freeSpins: 0,
      refBy: null,
      refJoinPaidAt: null,
      refDepositPaidAt: null,
      refDeposited: 0,
      clientSeed: randomBytes(8).toString('hex'),
      serverSeed,
      serverSeedHash: serverSeedHash(serverSeed),
      nonce: 0,
      revealed: [],
      history: [],
      createdAt: Date.now(),
      seenAt: Date.now(),
    };
    /* Прив'язка до запрошувача — ДО першого persist, щоб вона потрапила
       в базу разом із рештою запису, а не окремим дописом, який може
       не дійти. Саму виплату робить підписник нижче. */
    const by = Number(String(startParam ?? '').replace(/^ref_?/i, ''));
    if (Number.isInteger(by) && by > 0 && by !== user.id && this.players.has(by)) {
      rec.refBy = by;
    }

    this.players.set(user.id, rec);
    this.persist(rec);
    for (const fn of this.created) fn(rec);
    return rec;
  }

  /** Публічний зріз: без serverSeed, лише його хеш */
  publicState(rec: PlayerRecord) {
    return {
      telegramId: rec.telegramId,
      firstName: rec.firstName,
      username: rec.username ?? null,
      balance: rec.balance,
      dryStreaks: rec.dryStreaks,
      /* Клієнт малює по цьому плашку «БОНУС ГЕЙМ» і блокує зміну
         ставки: наступний раунд усе одно піде на збереженій. */
      pendingBonus: rec.pendingBonus ?? null,
      /* Подаровані прокрути видно в тому ж зрізі, що й баланс: клієнт
         малює по них плашку й розуміє, чому наступний спін безкоштовний. */
      freeSpins: rec.freeSpins ?? 0,
      pityAt: CONFIG.pity,
      clientSeed: rec.clientSeed,
      serverSeedHash: rec.serverSeedHash,
      nonce: rec.nonce,
    };
  }

  setClientSeed(rec: PlayerRecord, clientSeed: string): PlayerRecord {
    rec.clientSeed = clientSeed.trim().slice(0, 128) || rec.clientSeed;
    this.persist(rec);
    return rec;
  }

  /** Викликається в кінці кожного раунду — тут і зберігаємо гравця в БД
      (баланс, nonce, dryStreak, історія — усе свіже). */
  pushHistory(rec: PlayerRecord, result: RoundResult): void {
    rec.history.unshift(result);
    if (rec.history.length > HISTORY_LIMIT) rec.history.length = HISTORY_LIMIT;
    this.persist(rec);
  }

  /* ---- для CRM (доступ під адмін-логіном, див. admin/) ---- */

  /** Усі заведені гравці. */
  all(): PlayerRecord[] {
    return [...this.players.values()];
  }

  /** Гравець за telegram id або undefined. */
  byId(telegramId: number): PlayerRecord | undefined {
    return this.players.get(telegramId);
  }

  /** Списати з балансу. Використовується для РЕЗЕРВУ під виведення:
      гроші йдуть з балансу в момент заявки, а не коли адмін її погодить.

      Інакше гравець міг би замовити виплату й далі грати цими самими
      грошима: програв — на балансі нуль, а заявка все одно чекає
      виплати. Повертає розрізнений результат, щоб той, хто кличе, не
      сплутав «немає гравця» з «не вистачає коштів». */
  charge(telegramId: number, amount: number, by = 'система'):
  { ok: true; balance: number } | { ok: false; reason: 'no-player' | 'low-balance' } {
    const rec = this.players.get(telegramId);
    if (!rec) return { ok: false, reason: 'no-player' };
    if (rec.balance < amount) return { ok: false, reason: 'low-balance' };
    rec.balance -= amount;
    this.persist(rec);
    this.log.warn(`списання (${by}): ${telegramId} -${amount} -> ${rec.balance}`);
    return { ok: true, balance: rec.balance };
  }

  /** Ручне поповнення балансу. Повертає новий баланс або null, якщо
      такого гравця нема — той, хто кличе, ЗОБОВ'ЯЗАНИЙ це перевірити:
      null означає, що гроші не нараховані. */
  topUp(telegramId: number, amount: number, by = 'система'): number | null {
    const rec = this.players.get(telegramId);
    if (!rec) return null;
    rec.balance += amount;
    this.persist(rec);
    this.log.warn(`поповнення (${by}): ${telegramId} +${amount} -> ${rec.balance}`);
    return rec.balance;
  }

  /* Обнулити баланс.

     Не «списати скільки треба», а саме поставити нуль: інструмент для
     випадку, коли гроші нараховані помилково або гравця спіймали на
     зловживанні, і рахувати різницю руками — зайвий шанс помилитись.

     Скільки саме зняли, повертаємо назад тому, хто кличе, і пишемо в
     лог: обнулення необоротне, і слід від нього має лишитись. */
  zeroBalance(telegramId: number, by = 'система'):
  { balance: number; taken: number } | null {
    const rec = this.players.get(telegramId);
    if (!rec) return null;
    const taken = rec.balance;
    rec.balance = 0;
    this.persist(rec);
    this.log.warn(`обнулення (${by}): ${telegramId} -${taken} -> 0`);
    return { balance: 0, taken };
  }

  /* Видалити гравця НАЗАВЖДИ.

     Разом із ним зникають баланс, сид, nonce й історія раундів. Заявки
     на депозит і виведення живуть в інших колекціях і лишаються: це
     фінансові документи, і чистити їх заднім числом не можна — саме за
     ними потім і розбирають, куди пішли гроші.

     Зайде в гру знову — заведеться заново, з нуля й новим сидом. */
  remove(telegramId: number, by = 'система'): boolean {
    const rec = this.players.get(telegramId);
    if (!rec) return false;
    this.players.delete(telegramId);
    this.store?.delete(telegramId).catch((e) =>
      this.log.error(`не видалився гравець ${telegramId}: ${(e as Error).message}`));
    this.log.warn(`видалення (${by}): ${telegramId}, баланс на момент ${rec.balance}`);
    return true;
  }
}
