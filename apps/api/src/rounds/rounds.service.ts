import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CONFIG, TIER_BY_ID, resolveRound, roundCost } from '@minedrop/engine';
import type { RoundMode, RoundResult, TierId } from '@minedrop/engine';
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

  play(rec: PlayerRecord, bet: number, mode: RoundMode,
       idempotencyKey?: string, buy?: TierId): RoundResult {
    /* Ретрай того самого запиту не має списувати ставку вдруге.
       У вебв'ю телеграма мережа рветься регулярно, тож це не
       теоретичний випадок. */
    const key = idempotencyKey ? `${rec.telegramId}:${idempotencyKey.slice(0, 80)}` : null;
    if (key) {
      this.sweep();
      const hit = this.recent.get(key);
      if (hit) return hit.round;
    }

    const round = this.settle(rec, bet, mode, buy);
    if (key) this.recent.set(key, { at: Date.now(), round });
    return round;
  }

  private sweep(): void {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, v] of this.recent) if (v.at < cutoff) this.recent.delete(k);
  }

  private settle(rec: PlayerRecord, bet: number, mode: RoundMode, buy?: TierId): RoundResult {
    if (!CONFIG.bets.includes(bet as never)) {
      throw new BadRequestException(`Ставка должна быть одной из: ${CONFIG.bets.join(', ')}`);
    }

    /* БОНУС БАЙ. Кірку називає клієнт, тому перевіряємо тут: неіснуючий
       тір або тір без ціни — відмова. Ціну бере рушій із CONFIG.buy,
       клієнт її лише показує і на неї не впливає. */
    if (buy && (!TIER_BY_ID[buy] || !CONFIG.buy.price[buy])) {
      throw new BadRequestException('Неизвестная кирка');
    }
    /* Режим виводиться з buy, а не з того, що написав клієнт. Просити
       бонуску, не назвавши кірку, — суперечливий запит: мовчки зіграти
       звичайну ставку за цінником бонуски було б найгіршим варіантом. */
    if (mode === 'buy' && !buy) {
      throw new BadRequestException('Не выбрана кирка для бонус бая');
    }

    const cost = roundCost(mode, bet, buy);
    if (rec.balance < cost) throw new BadRequestException('Недостаточно монет');

    const balanceBefore = rec.balance;
    rec.balance -= cost;

    /* PITY рахується ОКРЕМО на кожній ставці. Серія на ставці 10 нічого
       не дає на ставці 250 — тож набити промахи по 10 і зняти гарантовану
       кірку на 250 не вийде. Перемкнувся туди-сюди — серія кожної ставки
       чекає на місці. */
    /* Куплена кірка гарантована сама по собі, тож серію промахів вона
       не витрачає: pity лишається на місці й спрацює на звичайній
       ставці, як і мав. */
    const streak = rec.dryStreaks[bet] ?? 0;
    const pity = !buy && streak >= CONFIG.pity;

    const { seed, nonce } = this.fairness.nextSeed(rec);
    const resolved = resolveRound(seed, mode, bet, pity, buy);

    rec.balance += resolved.payout;

    /* Лічильник пустих прокрутів цієї ставки: кірка (у т.ч. форсована)
       -> 0, промах -> +1. Інші ставки не чіпаємо. */
    const nextStreak = buy ? streak : (resolved.setup.tiers.length ? 0 : streak + 1);
    rec.dryStreaks[bet] = nextStreak;

    const result: RoundResult = {
      roundId: randomUUID(),
      mode: resolved.setup.mode,
      bet,
      cost,
      buy,
      seed,
      spins: resolved.setup.spins,
      tiers: resolved.setup.tiers,
      startCols: resolved.setup.startCols,
      pity: resolved.setup.pity,
      dryStreak: nextStreak,
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
