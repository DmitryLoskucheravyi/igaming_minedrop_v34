import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { resolveRound, roundCost, roundSeed, serverSeedHash, verifyCommit } from '@minedrop/engine';
import type { RoundMode } from '@minedrop/engine';
import type { PlayerRecord } from '../players/players.service';

/* ============================================================
   FAIRNESS — commit-reveal.

   Сервер публікує sha256(serverSeed) НАПЕРЕД і не може його
   підмінити заднім числом. Гравець додає свій clientSeed, тому
   сервер не може підібрати сид під конкретну людину. Сид раунду =
   HMAC(serverSeed, "clientSeed:nonce").

   Розкриття (rotate) закриває серію: старий serverSeed стає
   публічним, і кожен раунд із неї перераховується локально —
   рушій у клієнта той самий.
   ============================================================ */

@Injectable()
export class FairnessService {
  /** Сид наступного раунду. Викликається рівно один раз на раунд. */
  nextSeed(rec: PlayerRecord): { seed: string; nonce: number } {
    rec.nonce += 1;
    return { seed: roundSeed(rec.serverSeed, rec.clientSeed, rec.nonce), nonce: rec.nonce };
  }

  /** Закрити серію: розкрити поточний serverSeed і взяти новий. */
  rotate(rec: PlayerRecord) {
    const revealed = {
      serverSeed: rec.serverSeed,
      serverSeedHash: rec.serverSeedHash,
      clientSeed: rec.clientSeed,
      rounds: rec.nonce,
    };
    rec.revealed.unshift(revealed);
    if (rec.revealed.length > 10) rec.revealed.length = 10;

    const next = randomBytes(32).toString('hex');
    rec.serverSeed = next;
    rec.serverSeedHash = serverSeedHash(next);
    rec.nonce = 0;

    return { revealed, next: { serverSeedHash: rec.serverSeedHash, nonce: 0 } };
  }

  /** Перерахунок раунду з розкритих даних. Нічого не змінює. */
  verify(input: {
    serverSeed: string;
    serverSeedHash?: string;
    clientSeed: string;
    nonce: number;
    mode: RoundMode;
    bet: number;
  }) {
    const commitOk = input.serverSeedHash
      ? verifyCommit(input.serverSeed, input.serverSeedHash)
      : null;

    const seed = roundSeed(input.serverSeed, input.clientSeed, input.nonce);
    const r = resolveRound(seed, input.mode, input.bet);

    return {
      commitOk,
      seed,
      spins: r.setup.spins,
      tiers: r.setup.tiers,
      startCols: r.setup.startCols,
      sim: r.sim,
      cost: roundCost(input.mode, input.bet),
      rawPayout: r.rawPayout,
      payout: r.payout,
      capped: r.capped,
    };
  }
}
