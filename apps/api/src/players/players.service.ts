import {
  Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CONFIG, serverSeedHash } from '@minedrop/engine';
import type { RoundResult } from '@minedrop/engine';
import { ENV, type Env } from '../config/env';
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

   ТЕСТОВЕ ПОПОВНЕННЯ: поки гри без реальних грошей і без адмінки,
   findOrCreate() сам повертає баланс, якщо його не вистачає навіть
   на найдешевшу ставку. Спрацьовує на будь-якому зверненні гравця —
   рефреш аппки, новий раунд, відкриття панелі чесності — тому
   застрягти з 0 і без можливості грати далі не можна. Це навмисний
   тимчасовий костиль на час тестів, а НЕ адмін-видача чи компенсація:
   прибрати разом із переходом на файлову/БД-персистентність і
   справжнє поповнення балансу.
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

/* Найдешевша ставка з CONFIG.bets — поріг, нижче якого гравець
   фізично не може зробити жодного ходу. */
const MIN_PLAYABLE_BET = Math.min(...CONFIG.bets);

@Injectable()
export class PlayersService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PlayersService.name);
  private readonly players = new Map<number, PlayerRecord>();
  private store: PlayerStore | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async onModuleInit(): Promise<void> {
    if (!this.env.mongoUrl) {
      this.log.warn('MONGO_URL не заданий — гравці тільки in-memory, гинуть із рестартом.');
      return;
    }
    const store = new PlayerStore();
    try {
      await store.connect(this.env.mongoUrl);
      const rows = await store.loadAll();
      for (const r of rows) this.players.set(r.telegramId, r);
      this.store = store;
      this.log.log(`Завантажено гравців із БД: ${rows.length}`);
    } catch (e) {
      await store.close();
      this.log.error(`MongoDB недоступна (${(e as Error).message}). ` +
        'Працюємо in-memory — стан НЕ зберігається.');
      if (this.env.isProd) throw e;   // у проді без БД стартувати не можна
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.store?.close();
  }

  /** Асинхронно скидає гравця в БД (fire-and-forget, помилку лише логуємо). */
  persist(rec: PlayerRecord): void {
    this.store?.save(rec).catch((e) =>
      this.log.error(`не зберігся гравець ${rec.telegramId}: ${(e as Error).message}`));
  }

  /** Перший вхід — заводимо гравця; далі просто знаходимо.
      Пише в БД лише коли справді щось змінилось (створення / поповнення) —
      «останній вхід» без активності в БД не летить, це надто дрібно. */
  findOrCreate(user: TelegramUser): PlayerRecord {
    const found = this.players.get(user.id);
    if (found) {
      found.seenAt = Date.now();
      found.username = user.username ?? found.username;
      found.firstName = user.firstName || found.firstName;
      if (found.balance < MIN_PLAYABLE_BET) {
        this.log.warn(`тестове поповнення: ${found.telegramId} ${found.balance} -> ${CONFIG.startBalance}`);
        found.balance = CONFIG.startBalance;
        this.persist(found);
      }
      return found;
    }

    const serverSeed = randomBytes(32).toString('hex');
    const rec: PlayerRecord = {
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName,
      balance: CONFIG.startBalance,
      dryStreaks: {},
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

  /* ---- для адмін-панелі (тимчасова, поза продом) ---- */

  /** Усі заведені гравці. */
  all(): PlayerRecord[] {
    return [...this.players.values()];
  }

  /** Гравець за telegram id або undefined. */
  byId(telegramId: number): PlayerRecord | undefined {
    return this.players.get(telegramId);
  }

  /** Ручне поповнення балансу. Повертає новий баланс або null. */
  topUp(telegramId: number, amount: number): number | null {
    const rec = this.players.get(telegramId);
    if (!rec) return null;
    rec.balance += amount;
    this.persist(rec);
    this.log.warn(`адмін-поповнення: ${telegramId} +${amount} -> ${rec.balance}`);
    return rec.balance;
  }
}
