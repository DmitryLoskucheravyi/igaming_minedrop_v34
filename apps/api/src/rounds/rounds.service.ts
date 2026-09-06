import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CONFIG, resolveRound, roundCost } from '@minedrop/engine';
import type { RoundMode, RoundResult } from '@minedrop/engine';
import { PlayersService, type PlayerRecord } from '../players/players.service';
import { FairnessService } from '../fairness/fairness.service';

/* ============================================================
   ROUNDS — тут вирішується результат. Єдина точка, де рухаються гроші.

   Порядок навмисно такий:
     1. перевірили ставку й режим;
     2. списали вартість;
     3. взяли сид (nonce += 1) і ПОВНІСТЮ програли раунд у рушії;
     4. нарахували виплату;
     5. оновили стрік.
   Клієнт отримує сид і сам відтворює політ — але його арифметика
   ні на що не впливає, у балансі вже лежить серверне число.
   ============================================================ */

/* Скільки тримати відповідь під ключем ідемпотентності.
   Вистачає, щоб покрити ретраї обірваного запиту, і мало, щоб
   кеш не ріс. */
const IDEMPOTENCY_TTL_MS = 60_000;

@Injectable()
export class RoundsService {
  /** (telegramId + ключ) -> уже зіграний раунд */
  private readonly recent = new Map<string, { at: number; round: RoundResult }>();

  constructor(
    private readonly players: PlayersService,
    private readonly fairness: FairnessService,
  ) {}

  play(rec: PlayerRecord, bet: number, mode: RoundMode, idempotencyKey?: string): RoundResult {
    /* Ретрай того самого запиту не має списувати ставку вдруге.
       У вебв'ю телеграма мережа рветься регулярно, тож це не
       теоретичний випадок. */
    const key = idempotencyKey ? `${rec.telegramId}:${idempotencyKey.slice(0, 80)}` : null;
    if (key) {
      this.sweep();
      const hit = this.recent.get(key);
      if (hit) return hit.round;
    }

    const round = this.settle(rec, bet, mode);
    if (key) this.recent.set(key, { at: Date.now(), round });
    return round;
  }

  private sweep(): void {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, v] of this.recent) if (v.at < cutoff) this.recent.delete(k);
  }

  private settle(rec: PlayerRecord, bet: number, mode: RoundMode): RoundResult {
    if (!CONFIG.bets.includes(bet as never)) {
      throw new BadRequestException(`Ставка должна быть одной из: ${CONFIG.bets.join(', ')}`);
    }

    const cost = roundCost(mode, bet);
    if (rec.balance < cost) throw new BadRequestException('Недостаточно монет');

    const balanceBefore = rec.balance;
    rec.balance -= cost;

    const { seed, nonce } = this.fairness.nextSeed(rec);
    const resolved = resolveRound(seed, mode, bet);

    rec.balance += resolved.payout;

    const result: RoundResult = {
      roundId: randomUUID(),
      mode,
      bet,
      cost,
      seed,
      spins: resolved.setup.spins,
      tiers: resolved.setup.tiers,
      startCols: resolved.setup.startCols,
      sim: resolved.sim,
      rawPayout: resolved.rawPayout,
      payout: resolved.payout,
      capped: resolved.capped,
      multiplier: cost > 0 ? resolved.payout / cost : resolved.payout / bet,
      balanceBefore,
      balanceAfter: rec.balance,
      fair: {
        serverSeedHash: rec.serverSeedHash,
        clientSeed: rec.clientSeed,
        nonce,
      },
    };

    this.players.pushHistory(rec, result);
    return result;
  }
}
