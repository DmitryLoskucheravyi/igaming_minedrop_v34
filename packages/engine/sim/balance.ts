/* ============================================================
   Фактичний RTP гри при поточному payoutK. Реальна фізика,
   лише звичайні ставки (бонуску прибрано з гри).

   npm run sim:balance -- [ставок]
   ============================================================ */

import { CONFIG, TIERS } from '../src/config';
import { resolveRound } from '../src/round';
import type { TierId } from '../src/types';
import { seedAt } from './seeds';

const N = parseInt(process.argv[2] || '15000', 10);

const st = {
  drops: 0, spins: 0, depth: 0, secs: 0, blocks: 0, mults: 0, tnts: 0, upgrades: 0,
  perTier: {} as Record<string, { n: number; sum: number }>,
};
for (const t of TIERS) st.perTier[t.id] = { n: 0, sum: 0 };

/* ставка = 1, тому виплата одразу в іксах */
function playBet(seed: string, pity: boolean): { x: number; pick: TierId | null } {
  const r = resolveRound(seed, 'bet', 1, pity);
  st.spins += r.setup.spins.length;
  const tier = r.setup.tiers[0] ?? null;
  if (!tier) return { x: 0, pick: null };

  const x = r.payout;
  st.drops++;
  st.depth += r.sim.depth;
  st.secs += r.sim.timeSec;
  st.blocks += r.sim.blocks;
  st.mults += r.sim.mults;
  st.tnts += r.sim.tnts;
  st.upgrades += r.sim.upgrades;
  st.perTier[tier].n++;
  st.perTier[tier].sum += x;
  return { x, pick: tier };
}

let baseX = 0, dry = 0, dryNow = 0, bestBet = 0, capHits = 0, pityHits = 0;
const betX: number[] = [];

for (let i = 0; i < N; i++) {
  const pity = dryNow >= CONFIG.pity;
  if (pity) pityHits++;
  const r = playBet(seedAt(i), pity);
  baseX += r.x; betX.push(r.x);
  if (r.x > bestBet) bestBet = r.x;
  if (r.x >= CONFIG.maxWinX) capHits++;
  if (!r.pick) { dry++; dryNow++; } else dryNow = 0;
}

const eBase = baseX / N;

console.log('=== ЗВИЧАЙНА ГРА ===');
console.log('ставок:', N, '| кірка в', ((st.drops / N) * 100).toFixed(1) + '% ставок',
            '| без кірки:', ((dry / N) * 100).toFixed(1) + '%',
            '| pity спрацював', pityHits, 'раз');
console.log('політ: глибина', (st.depth / st.drops).toFixed(1),
            '| блоків', (st.blocks / st.drops).toFixed(1),
            '| час', (st.secs / st.drops).toFixed(1) + 'с',
            '| Х-блоків', (st.mults / st.drops).toFixed(3),
            '| TNT', (st.tnts / st.drops).toFixed(2),
            '| апгрейдів', (st.upgrades / st.drops).toFixed(3));

console.log('\n=== RTP при payoutK =', CONFIG.payoutK, '===');
console.log('RTP:', (eBase * 100).toFixed(1) + '%');
console.log('макс за ставку x' + bestBet.toFixed(0),
            '| стеля x' + CONFIG.maxWinX + ' спрацювала', capHits, 'разів');

const names = ['0x (нічого)', '<0.5x', '0.5-1x', '1-2x', '2-5x', '5-20x', '20x+'];
const buckets = [0, 0, 0, 0, 0, 0, 0];
for (const x of betX)
  buckets[x === 0 ? 0 : x < 0.5 ? 1 : x < 1 ? 2 : x < 2 ? 3 : x < 5 ? 4 : x < 20 ? 5 : 6]++;
console.log('\nрозподіл ставки:');
buckets.forEach((b, i) => console.log('  ' + names[i].padEnd(12), ((b / N) * 100).toFixed(1) + '%'));

console.log('\nпо кірках (один політ):');
for (const t of TIERS) {
  const p = st.perTier[t.id];
  console.log('  ' + t.id.padEnd(8), 'HP', String(t.hp).padStart(3), 'урон', t.dmg,
              '| випала в', ((p.n / N) * 100).toFixed(2) + '% ставок',
              '| сер. виплата x' + (p.sum / Math.max(1, p.n)).toFixed(2));
}
