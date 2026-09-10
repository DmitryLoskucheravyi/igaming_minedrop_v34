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
   один раз, при заведенні. Далі баланс поповнюється ЛИШЕ через CRM —
   вручну адміном або підтвердженням заявки на депозит.

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
  findOrCreate(user: TelegramUser): PlayerRecord {
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
      clientSeed: randomBytes(8).toString('hex'),
      serverSeed,
      serverSeedHash: serverSeedHash(serverSeed),
      nonce: 0,
      revealed: [],
      history: [],
      createdAt: Date.now(),
      seenAt: Date.now(),
    };
    this.players.set(user.id, rec);
    this.persist(rec);
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
