import { BadRequestException, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CONFIG, serverSeedHash } from '@minedrop/engine';
import type { RoundResult } from '@minedrop/engine';
import { MongoService } from '../db/mongo.service';
import { PlayerStore } from './player-store';
import type { TelegramUser } from '../telegram/init-data';
import { packPrice, type SpinPack } from '../spins/spins.types';

/* ============================================================
   PLAYERS — стан гравця живе на СЕРВЕРІ.

   Тут навмисно все, що впливає на коіни: баланс, стрік, nonce,
   виграна бонуска. Клієнт цих цифр не тримає — він їх лише показує.
   Якби стрік лічився в браузері, його можна було б накрутити з
   консолі й отримати бонуску за x70 безкоштовно.

   КЛЮЧ — TELEGRAM ID. Гравець — той, чий initData підписаний ботовим
   токеном. Відкрив мініапс з іншого пристрою — той самий баланс;
   підмінив id у запиті — підпис не зійдеться.

   СХОВИЩЕ: у процесі — Map, а копія лежить у MongoDB (PlayerStore).
   На старті все зчитується в Map; після кожної зміни документ гравця
   повністю перезаписується в БД (fire-and-forget, persist()). MONGO_URL
   порожній -> тільки Map, стан гине з рестартом (dev без БД).

   ВАЛЮТА ОДНА — КОІНИ. Гра розважальна: коіни не купуються й не
   виводяться. Звідки вони беруться:
     - CONFIG.startBalance при заведенні гравця;
     - щоденна нагорода (поповнення + серія заходів, див. daily/);
     - колесо, запрошені друзі, виграші в раундах;
     - ручне нарахування в CRM.
   Усі ці шляхи йдуть через credit(): там і збереження, і запис у лог.
   ============================================================ */

export interface PlayerRecord {
  telegramId: number;
  username?: string;
  firstName: string;

  /** баланс, коінів */
  coins: number;

  /* Пустих прокрутів поспіль ОКРЕМО по кожній ставці: ключ — номінал
     ставки, значення — довжина серії на ній. Кірка (в т.ч. форсована)
     обнуляє лічильник СВОЄЇ ставки; промах — +1 до нього. Серія на
     ставці 10 не має жодного стосунку до серії на ставці 250, тож
     перемкнути гарантовану кірку на дорожчу ставку неможливо. */
  dryStreaks: Record<number, number>;

  /* Виграна скаттерами, ще не зіграна бонуска.

     Ставка зберігається РАЗОМ із нею і не підлягає зміні. Інакше
     з'являється проста схема: набити скаттери на ставці 10, а
     безкоштовну бонуску зіграти на 2000 — виплата ж рахується від
     ставки поточного раунду. Тому бонуска належить тій ставці, на якій
     її виграли.

     null — виграної бонуски немає. */
  pendingBonus: { bet: number } | null;

  /* РЕФЕРАЛЬНА ПРИВ'ЯЗКА.

     refBy — хто запросив. Ставиться РІВНО ОДИН РАЗ, у момент
     створення запису, і більше ніколи: інакше гравець переписував би
     її на друга щоразу, коли той хоче бонус.

     Дата виплати лежить тут само, а не в запрошувача: подія належить
     запрошеному (він прийшов), а виплата — лише її наслідок. Так одна
     подія не може оплатитись двічі. */
  refBy: number | null;
  refJoinPaidAt: number | null;

  /* КУПЛЕНІ ФРІСПІНИ. buySpins — скільки лишилось, buySpinBet — ставка,
     за якою пакет куплений (вона ж і грається). Ставка зберігається
     разом із пакетом, а не береться поточна: інакше пакет, куплений на
     10, можна було б відіграти на 2000. */
  buySpins: number;
  buySpinBet: number;

  /* КОЛЕСО.
     wheelAt — коли крутили востаннє; null (або 0) означає «жодного разу»,
     і саме за цим упізнається перший, гарантований прокрут.
     freeSpins — подаровані прокрути, які чекають своєї черги. Грають
     вони на фіксованій ставці (WHEEL_FREE_BET), а не на поточній. */
  wheelAt: number | null;
  freeSpins: number;

  /* ЩОДЕННА НАГОРОДА (див. daily/).
     dailyDay — календарна доба (YYYY-MM-DD у DAILY_TZ), за яку нагороду
       востаннє забрали; null — ще жодного разу.
     streak — день серії, забраний тоді (1..30). Наступного дня серія
       продовжується, пропуск доби скидає її на перший день. */
  dailyDay: string | null;
  streak: number;

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

  /* Хто хоче знати про НОВОГО гравця. Спостерігач, а не прямий виклик,
     бо інакше цей сервіс мусив би знати про реферальну систему, а вона
     вже знає про нього — вийшло б кільце, яке Nest розв'яже хіба
     forwardRef. Тут же напрямок один: коіни за запрошення нараховує
     той, хто про них знає, а гравці лише повідомляють про появу. */
  private readonly created: ((rec: PlayerRecord) => void)[] = [];

  onCreated(fn: (rec: PlayerRecord) => void): void {
    this.created.push(fn);
  }

  /** Перший вхід — заводимо гравця; далі просто знаходимо.
      Пише в БД лише коли справді щось змінилось (створення) — «останній
      вхід» без активності в БД не летить, це надто дрібно.

      startParam — стартовий параметр посилання з ПІДПИСАНОГО initData
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
      coins: CONFIG.startBalance,
      dryStreaks: {},
      pendingBonus: null,
      wheelAt: null,
      freeSpins: 0,
      refBy: null,
      refJoinPaidAt: null,
      buySpins: 0,
      buySpinBet: 0,
      dailyDay: null,
      streak: 0,
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

  /* ---- РУХ КОІНІВ ---- */

  /** Скільки коінів у гравця. */
  balance(rec: PlayerRecord): number {
    return rec.coins ?? 0;
  }

  /** Списати ставку. Чи вистачає — перевіряє той, хто кличе. */
  stake(rec: PlayerRecord, amount: number): void {
    rec.coins = this.balance(rec) - amount;
  }

  /** Зарахувати виграш раунду. */
  payout(rec: PlayerRecord, amount: number): void {
    if (amount > 0) rec.coins = this.balance(rec) + amount;
  }

  /** Нарахувати коіни поза раундом (щоденна нагорода, колесо, друг,
      CRM). Повертає новий баланс або null, якщо такого гравця нема —
      той, хто кличе, ЗОБОВ'ЯЗАНИЙ це перевірити: null означає, що нічого
      не нараховано. */
  credit(telegramId: number, amount: number, why: string): number | null {
    const rec = this.players.get(telegramId);
    if (!rec) return null;
    rec.coins = this.balance(rec) + amount;
    this.persist(rec);
    this.log.log(`+${amount} (${why}): ${telegramId} -> ${rec.coins}`);
    return rec.coins;
  }

  /* Купівля пакета фріспінів: списуємо ціну, видаємо прокрути.

     Ціну рахує сервер зі ставки (packPrice), число з клієнта сюди не
     доходить взагалі — інакше пакет можна було б купити за одиницю. */
  buySpins(rec: PlayerRecord, pack: SpinPack): { left: number; bet: number; balance: number } {
    const price = packPrice(pack);
    if (this.balance(rec) < price) {
      throw new BadRequestException(`Не хватает коинов: пакет стоит ${price}`);
    }
    rec.coins -= price;
    rec.buySpins = pack.spins;
    rec.buySpinBet = pack.bet;
    this.persist(rec);
    this.log.log(`куплено ${pack.spins} фріспінів (${pack.id}): `
      + `${rec.telegramId} -${price}, ставка ${pack.bet} -> ${rec.coins}`);
    return { left: rec.buySpins, bet: pack.bet, balance: rec.coins };
  }

  /** Публічний зріз: без serverSeed, лише його хеш */
  publicState(rec: PlayerRecord) {
    return {
      telegramId: rec.telegramId,
      firstName: rec.firstName,
      username: rec.username ?? null,
      balance: this.balance(rec),
      dryStreaks: rec.dryStreaks,
      /* Клієнт малює по цьому плашку «БОНУС ГЕЙМ» і блокує зміну
         ставки: наступний раунд усе одно піде на збереженій. */
      pendingBonus: rec.pendingBonus ?? null,
      /* Подаровані прокрути видно в тому ж зрізі, що й баланс: клієнт
         малює по них плашку й розуміє, чому наступний спін безкоштовний. */
      freeSpins: rec.freeSpins ?? 0,
      /* Куплені прокрути — окремо від подарованих: у них інша ставка й
         інший шанс, і плутати їх в інтерфейсі не можна. */
      buySpins: rec.buySpins ?? 0,
      buySpinBet: rec.buySpinBet ?? 0,
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

  /* Обнулити баланс.

     Не «списати скільки треба», а саме поставити нуль: інструмент для
     випадку, коли коіни нараховані помилково або гравця спіймали на
     зловживанні. Скільки саме зняли, повертаємо й пишемо в лог:
     обнулення необоротне, і слід від нього має лишитись. */
  zeroBalance(telegramId: number, by = 'система'):
  { balance: number; taken: number } | null {
    const rec = this.players.get(telegramId);
    if (!rec) return null;
    const taken = this.balance(rec);
    rec.coins = 0;
    this.persist(rec);
    this.log.warn(`обнулення (${by}): ${telegramId} -${taken} -> 0`);
    return { balance: 0, taken };
  }

  /* Видалити гравця НАЗАВЖДИ: разом із ним зникають баланс, сид, nonce,
     серія заходів й історія раундів. Зайде в гру знову — заведеться
     заново, з нуля й новим сидом. */
  remove(telegramId: number, by = 'система'): boolean {
    const rec = this.players.get(telegramId);
    if (!rec) return false;
    this.players.delete(telegramId);
    this.store?.delete(telegramId).catch((e) =>
      this.log.error(`не видалився гравець ${telegramId}: ${(e as Error).message}`));
    this.log.warn(`видалення (${by}): ${telegramId}, баланс на момент ${this.balance(rec)}`);
    return true;
  }
}
