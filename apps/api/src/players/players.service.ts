import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CONFIG, serverSeedHash } from '@minedrop/engine';
import type { RoundResult } from '@minedrop/engine';
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

   СХОВИЩЕ: in-memory. Це заглушка для розробки — процес перезапустили,
   баланси обнулились. Під продакшн міняється тільки цей файл:
   методи вже написані як «знайти -> змінити -> зберегти», а списання
   й нарахування зроблені однією операцією в RoundsService, щоб їх
   можна було загорнути в транзакцію.

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
  dryStreak: number;         // пустих ставок поспіль (для pity, CONFIG.pity)

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
export class PlayersService {
  private readonly log = new Logger(PlayersService.name);
  private readonly players = new Map<number, PlayerRecord>();

  /** Перший вхід — заводимо гравця; далі просто знаходимо. */
  findOrCreate(user: TelegramUser): PlayerRecord {
    const found = this.players.get(user.id);
    if (found) {
      found.seenAt = Date.now();
      found.username = user.username ?? found.username;
      found.firstName = user.firstName || found.firstName;
      if (found.balance < MIN_PLAYABLE_BET) {
        this.log.warn(`тестове поповнення: ${found.telegramId} ${found.balance} -> ${CONFIG.startBalance}`);
        found.balance = CONFIG.startBalance;
      }
      return found;
    }

    const serverSeed = randomBytes(32).toString('hex');
    const rec: PlayerRecord = {
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName,
      balance: CONFIG.startBalance,
      dryStreak: 0,
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
    return rec;
  }

  /** Публічний зріз: без serverSeed, лише його хеш */
  publicState(rec: PlayerRecord) {
    return {
      telegramId: rec.telegramId,
      firstName: rec.firstName,
      username: rec.username ?? null,
      balance: rec.balance,
      dryStreak: rec.dryStreak,
      pityAt: CONFIG.pity,
      clientSeed: rec.clientSeed,
      serverSeedHash: rec.serverSeedHash,
      nonce: rec.nonce,
    };
  }

  setClientSeed(rec: PlayerRecord, clientSeed: string): PlayerRecord {
    rec.clientSeed = clientSeed.trim().slice(0, 128) || rec.clientSeed;
    return rec;
  }

  pushHistory(rec: PlayerRecord, result: RoundResult): void {
    rec.history.unshift(result);
    if (rec.history.length > HISTORY_LIMIT) rec.history.length = HISTORY_LIMIT;
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
    this.log.warn(`адмін-поповнення: ${telegramId} +${amount} -> ${rec.balance}`);
    return rec.balance;
  }
}
