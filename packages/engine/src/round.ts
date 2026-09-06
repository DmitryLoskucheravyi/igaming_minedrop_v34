/* ============================================================
   ROUND — повний раунд з одного сида.

   Це той самий код, який виконує СЕРВЕР (щоб порахувати виплату)
   і КЛІЄНТ (щоб її програти). Сервер віддає сид; клієнт із того
   самого сида збирає ту саму рулетку, ту саму шахту і ту саму
   траєкторію — і в кінці звіряє свою суму з серверною.

   Клієнт нічого не вирішує. Якщо його результат розійшовся з
   серверним — правий сервер, а розбіжність це баг детермінізму.
   ============================================================ */

import { CONFIG, reelTable, tierIndex, TIER_BY_ID } from './config';
import { pickWeighted, stream, streamRoot, type Rng } from './rng';
import { Run } from './run';
import { Mine } from './world';
import type { RoundMode, RunSummary, SpinResult, TierId } from './types';

export interface RoundSetup {
  mode: RoundMode;
  spins: SpinResult[];    // що випало на кожному прокруті; null = «пусто»
  tiers: TierId[];        // кірки, що йдуть у шахту
  startCols: number[];    // з яких колонок стартують
}

/* ---------------- рулетка ---------------- */

/* Звичайна ставка: CONFIG.spinsPerBet прокрутів (зараз 1 — один
   потяг, як у 777), ПЕРША Ж кірка зупиняє решту. Не випало за всі —
   ставка згоріла. Цикл лишився параметризованим навмисно: значення
   1 — поточне ігрове рішення, а не структурне обмеження коду. */
function spinBet(rnd: Rng): { spins: SpinResult[]; tiers: TierId[] } {
  const table = reelTable();
  const spins: SpinResult[] = [];
  for (let i = 0; i < CONFIG.spinsPerBet; i++) {
    const slot = pickWeighted(table, rnd);
    const tier = slot.tier;
    spins.push(tier ? (tier.id as TierId) : null);
    if (tier) return { spins, tiers: [tier.id as TierId] };
  }
  return { spins, tiers: [] };
}

/* ---------------- збірка ---------------- */

/** Що випало в раунді. Без фізики — клієнт кличе це, щоб крутити рулетку. */
export function buildSetup(seed: string, mode: RoundMode = 'bet'): RoundSetup {
  const reelRnd = stream(seed, 'reel');
  const { spins, tiers } = spinBet(reelRnd);

  const colRnd = stream(seed, 'cols');
  const startCols = tiers.length ? [Math.floor(colRnd() * CONFIG.cols)] : [];

  return { mode, spins, tiers, startCols };
}

/** Шахта + забіг, готові крокувати. Клієнт тикає їх сам, у ритмі кадрів. */
export function createRun(seed: string, setup: RoundSetup): { mine: Mine; run: Run } | null {
  if (!setup.tiers.length) return null;
  const mine = new Mine(CONFIG.cols, streamRoot(seed, 'mine'));
  const run = new Run(
    setup.tiers.map((id) => TIER_BY_ID[id]),
    mine,
    { cols: setup.startCols, rnd: stream(seed, 'phys') },
  );
  return { mine, run };
}

export function summarize(run: Run | null): RunSummary {
  if (!run) {
    return { collected: 0, multChain: 1, blocks: 0, hits: 0, depth: 0, mults: 0,
             tnts: 0, upgrades: 0, timeSec: 0, steps: 0, reason: 'broken' };
  }
  return {
    collected: run.collected,
    multChain: run.multChain,
    blocks: run.blocks,
    hits: run.hits,
    depth: run.depth,
    mults: run.mults,
    tnts: run.tnts,
    upgrades: run.upgrades,
    timeSec: run.time,
    steps: run.steps,
    reason: run.reason ?? 'broken',
  };
}

export interface Resolved {
  setup: RoundSetup;
  sim: RunSummary;
  rawPayout: number;
  payout: number;
  capped: boolean;
}

/** Повний прогін раунду до кінця. Це і є «серверна правда». */
export function resolveRound(seed: string, mode: RoundMode, bet: number): Resolved {
  const setup = buildSetup(seed, mode);
  const made = createRun(seed, setup);
  const run = made ? made.run.runToEnd() : null;
  const sim = summarize(run);

  const rawPayout = Math.round(sim.collected * bet / CONFIG.payoutK);
  const cap = bet * CONFIG.maxWinX;
  return {
    setup,
    sim,
    rawPayout,
    payout: Math.min(rawPayout, cap),
    capped: rawPayout > cap,
  };
}

/** Ціна входу в раунд = ставка. */
export function roundCost(_mode: RoundMode, bet: number): number {
  return bet;
}

export { tierIndex };
