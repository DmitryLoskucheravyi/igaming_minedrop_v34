/* ============================================================
   ROUND — повний раунд з одного сида.

   Це той самий код, який виконує СЕРВЕР (щоб порахувати виплату)
   і КЛІЄНТ (щоб її програти). Сервер віддає сид; клієнт із того
   самого сида збирає ту саму рулетку, ту саму шахту і ту саму
   траєкторію — і в кінці звіряє свою суму з серверною.

   Клієнт нічого не вирішує. Якщо його результат розійшовся з
   серверним — правий сервер, а розбіжність це баг детермінізму.
   ============================================================ */

import {
  bonusReelTable, CONFIG, reelTable, tierIndex, tierOnlyTable, TIER_BY_ID,
} from './config';
import { pickWeighted, stream, streamRoot, type Rng } from './rng';
import { Run } from './run';
import { Mine } from './world';
import type { RoundMode, RunSummary, SpinResult, Tier, TierId } from './types';

export interface RoundSetup {
  mode: RoundMode;
  bonus: boolean;         // бонусний раунд (15 прокрутів, кірки разом)
  spins: SpinResult[];    // що випало на кожному прокруті; null = «пусто»
  tiers: TierId[];        // кірки, що йдуть у шахту
  startCols: number[];    // з яких колонок стартують
}

const isBonusMode = (m: RoundMode) => m === 'bonus-buy' || m === 'bonus-streak';

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

/* Бонуска: крутить усі spins разів, збирає ВСІ кірки.
   guarantee — якщо під кінець досі нічого, останні прокрути форсяться. */
function spinBonus(rnd: Rng): { spins: SpinResult[]; tiers: TierId[] } {
  const B = CONFIG.bonus;
  const table = bonusReelTable();
  const forced = tierOnlyTable();
  const spins: SpinResult[] = [];
  const tiers: TierId[] = [];

  for (let k = 0; k < B.spins; k++) {
    let tier: Tier | null = pickWeighted(table, rnd).tier;
    const left = B.spins - k;
    if (!tier && tiers.length < B.guarantee && left <= B.guarantee - tiers.length) {
      tier = pickWeighted(forced, rnd).tier;
    }
    spins.push(tier ? (tier.id as TierId) : null);
    if (tier) tiers.push(tier.id as TierId);
  }
  return { spins, tiers };
}

/* ---------------- стартові колонки ---------------- */

function spreadCols(n: number, cols: number, rnd: Rng): number[] {
  const all: number[] = [];
  for (let i = 0; i < cols; i++) all.push(i);
  for (let i = all.length - 1; i > 0; i--) {          // перемішуємо
    const j = Math.floor(rnd() * (i + 1));
    const t = all[i]; all[i] = all[j]; all[j] = t;
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(all[i % cols]);
  return out;
}

/* ---------------- збірка ---------------- */

/** Що випало в раунді. Без фізики — клієнт кличе це, щоб крутити рулетку. */
export function buildSetup(seed: string, mode: RoundMode): RoundSetup {
  const bonus = isBonusMode(mode);
  const reelRnd = stream(seed, 'reel');
  const { spins, tiers } = bonus ? spinBonus(reelRnd) : spinBet(reelRnd);

  const colRnd = stream(seed, 'cols');
  const startCols = tiers.length
    ? (bonus ? spreadCols(tiers.length, CONFIG.cols, colRnd)
             : [Math.floor(colRnd() * CONFIG.cols)])
    : [];

  return { mode, bonus, spins, tiers, startCols };
}

/** Шахта + забіг, готові крокувати. Клієнт тикає їх сам, у ритмі кадрів. */
export function createRun(seed: string, setup: RoundSetup): { mine: Mine; run: Run } | null {
  if (!setup.tiers.length) return null;
  const mine = new Mine(CONFIG.cols, streamRoot(seed, 'mine'), setup.bonus);
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

/** Ціна входу в раунд */
export function roundCost(mode: RoundMode, bet: number): number {
  return mode === 'bonus-buy' ? bet * CONFIG.bonus.buyCost
       : mode === 'bonus-streak' ? 0        // виграна бонуска — безкоштовна
       : bet;
}

export { tierIndex };
