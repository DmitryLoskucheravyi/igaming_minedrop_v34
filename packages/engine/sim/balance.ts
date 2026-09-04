/* ============================================================
   Фактичний RTP гри при поточному payoutK: звичайні ставки,
   бонуски за стрік і куплені бонуски. Реальна фізика.

   npm run sim:balance -- [ставок]
   ============================================================ */

import { CONFIG, TIERS } from '../src/config';
import { resolveRound } from '../src/round';
import type { TierId } from '../src/types';
import { seedAt } from './seeds';

const N = parseInt(process.argv[2] || '15000', 10);
const B = CONFIG.bonus;

const st = {
  drops: 0, spins: 0, depth: 0, secs: 0, blocks: 0, baseMults: 0,
  bPicks: 0, bMults: 0, bSecs: 0, bRuns: 0,
  perTier: {} as Record<string, { n: number; sum: number }>,
};
for (const t of TIERS) st.perTier[t.id] = { n: 0, sum: 0 };

/* ставка = 1, тому виплата одразу в іксах */
function playBet(seed: string): { x: number; pick: TierId | null } {
  const r = resolveRound(seed, 'bet', 1);
  st.spins += r.setup.spins.length;
  const tier = r.setup.tiers[0] ?? null;
  if (!tier) return { x: 0, pick: null };

  const x = r.payout;
  st.drops++;
  st.depth += r.sim.depth;
  st.secs += r.sim.timeSec;
  st.blocks += r.sim.blocks;
  st.baseMults += r.sim.mults;
  st.perTier[tier].n++;
  st.perTier[tier].sum += x;
  return { x, pick: tier };
}

function playBonus(seed: string): number {
  const r = resolveRound(seed, 'bonus-buy', 1);
  st.bPicks += r.setup.tiers.length;
  st.bMults += r.sim.mults;
  st.bSecs += r.sim.timeSec;
  st.bRuns++;
  return r.payout;
}

let baseX = 0, streakX = 0, streak = 0, triggers = 0, dry = 0, bestBet = 0, capHits = 0;
const betX: number[] = [];
let bonusSeed = 2_000_000;

for (let i = 0; i < N; i++) {
  const r = playBet(seedAt(i));
  baseX += r.x; betX.push(r.x);
  if (r.x > bestBet) bestBet = r.x;
  if (r.x >= CONFIG.maxWinX) capHits++;
  if (!r.pick) dry++;

  if (r.pick) streak++; else streak = 0;
  if (streak >= B.streak) { streak = 0; triggers++; streakX += playBonus(seedAt(bonusSeed++)); }
}

const M = Math.max(500, Math.round(N / 15));
let buyX = 0, bestBonus = 0;
const bonusX: number[] = [];
for (let i = 0; i < M; i++) {
  const x = playBonus(seedAt(3_000_000 + i));
  buyX += x; bonusX.push(x);
  if (x > bestBonus) bestBonus = x;
}

const eBase = baseX / N, eStreak = streakX / N, eBonus = buyX / M;
const sortedB = bonusX.slice().sort((a, b) => a - b);

console.log('=== ЗВИЧАЙНА ГРА ===');
console.log('ставок:', N, '| кірка в', ((st.drops / N) * 100).toFixed(1) + '% ставок',
            '(' + ((st.drops / st.spins) * 100).toFixed(1) + '% прокрутів)',
            '| без кірки:', ((dry / N) * 100).toFixed(1) + '%');
console.log('політ: глибина', (st.depth / st.drops).toFixed(1),
            '| блоків', (st.blocks / st.drops).toFixed(1),
            '| час', (st.secs / st.drops).toFixed(1) + 'с',
            '| Х-блоків', (st.baseMults / st.drops).toFixed(3));

console.log('\n=== БОНУСКА ===');
console.log('стрік', B.streak, 'спрацював', triggers, 'разів — раз на',
            (N / Math.max(1, triggers)).toFixed(0), 'ставок');
console.log('кірок у бонусці:', (st.bPicks / st.bRuns).toFixed(1),
            '| Х-блоків:', (st.bMults / st.bRuns).toFixed(2),
            '| час:', (st.bSecs / st.bRuns).toFixed(0) + 'с');
console.log('куплена бонуска: сер. x' + eBonus.toFixed(1),
            '| медіана x' + sortedB[sortedB.length >> 1].toFixed(1),
            '| макс x' + bestBonus.toFixed(0),
            '| ціна x' + B.buyCost, '=> RTP купівлі', ((eBonus / B.buyCost) * 100).toFixed(0) + '%');

console.log('\n=== RTP при payoutK =', CONFIG.payoutK, '===');
console.log('звичайна гра:', (eBase * 100).toFixed(1) + '%',
            '| бонуски за стрік:', (eStreak * 100).toFixed(1) + '%',
            '| РАЗОМ:', ((eBase + eStreak) * 100).toFixed(1) + '%');
/* Стрік спрацьовує рідко, тому пряма оцінка шумна.
   Точніше: частота стріку * вартість бонуски, виміряна на M зразках. */
const f = triggers / N;
const eStreakLV = f * eBonus;
console.log('точніша оцінка (частота стріку x вартість бонуски):',
            'бонуски', (eStreakLV * 100).toFixed(1) + '%',
            '| РАЗОМ', ((eBase + eStreakLV) * 100).toFixed(1) + '%');
console.log('макс за звичайну ставку x' + bestBet.toFixed(0),
            '| стеля x' + CONFIG.maxWinX + ' спрацювала', capHits, 'разів');

const names = ['0x (нічого)', '<0.5x', '0.5-1x', '1-2x', '2-5x', '5-20x', '20x+'];
const buckets = [0, 0, 0, 0, 0, 0, 0];
for (const x of betX)
  buckets[x === 0 ? 0 : x < 0.5 ? 1 : x < 1 ? 2 : x < 2 ? 3 : x < 5 ? 4 : x < 20 ? 5 : 6]++;
console.log('\nрозподіл звичайної ставки:');
buckets.forEach((b, i) => console.log('  ' + names[i].padEnd(12), ((b / N) * 100).toFixed(1) + '%'));

console.log('\nпо кірках (один політ):');
for (const t of TIERS) {
  const p = st.perTier[t.id];
  console.log('  ' + t.id.padEnd(8), 'HP', String(t.hp).padStart(3), 'урон', t.dmg,
              '| випала в', ((p.n / N) * 100).toFixed(2) + '% ставок',
              '| сер. виплата x' + (p.sum / Math.max(1, p.n)).toFixed(2));
}
