/* Диагностика по тирам: форсим каждую кирку, N забегов, смотрим что реально
   происходит внутри. npx tsx sim/_tierdiag.ts [N] */
import { CONFIG, TIERS, TIER_BY_ID } from '../src/config';
import { Run } from '../src/run';
import { Mine } from '../src/world';
import { stream, streamRoot } from '../src/rng';
import { roundSeed } from '../src/fairness';

const N = parseInt(process.argv[2] || '4000', 10);
const K = CONFIG.payoutK;

for (const t of TIERS) {
  let coll = 0, blocks = 0, depth = 0, secs = 0, hits = 0, mults = 0, tnts = 0, ups = 0;
  let zero = 0, best = 0;
  const xs: number[] = [];
  const oreBroken: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    const seed = roundSeed('tierdiag-' + t.id, 'c', i + 1);
    const mine = new Mine(CONFIG.cols, streamRoot(seed, 'mine'));
    const colRnd = stream(seed, 'cols');
    const run = new Run([TIER_BY_ID[t.id]], mine,
      { cols: [Math.floor(colRnd() * CONFIG.cols)], rnd: stream(seed, 'phys') });
    // считаем сломанную руду по событиям
    while (!run.over) {
      run.events.length = 0;
      run.tick();
      for (const e of run.events) {
        if (e.t === 'break') oreBroken[e.id] = (oreBroken[e.id] || 0) + 1;
      }
    }
    const x = run.collected / K;
    xs.push(x);
    coll += run.collected; blocks += run.blocks; depth += run.depth;
    secs += run.time; hits += run.hits; mults += run.mults; tnts += run.tnts; ups += run.upgrades;
    if (x === 0) zero++;
    if (x > best) best = x;
  }
  xs.sort((a, b) => a - b);
  const q = (p: number) => xs[Math.min(N - 1, Math.floor(N * p))];
  const ore = Object.entries(oreBroken).filter(([k]) => !['grass','dirt','stone'].includes(k))
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / N).toFixed(1)}`).join('  ');
  console.log(t.name.padEnd(8),
    'HP', String(t.hp).padStart(3), 'dmg', t.dmg,
    '| avg x' + (coll / N / K).toFixed(2).padStart(6),
    '| p50 x' + q(0.5).toFixed(1), 'p90 x' + q(0.9).toFixed(1), 'p99 x' + q(0.99).toFixed(0), 'max x' + best.toFixed(0),
    '| zero ' + (zero / N * 100).toFixed(0) + '%');
  console.log('         глуб', (depth / N).toFixed(0), 'блоков', (blocks / N).toFixed(0),
    'время', (secs / N).toFixed(0) + 'с', 'ударов', (hits / N).toFixed(0),
    'X-блоков', (mults / N).toFixed(2), 'TNT', (tnts / N).toFixed(1), 'апгр', (ups / N).toFixed(2));
  console.log('         руда/забег:', ore);
}
