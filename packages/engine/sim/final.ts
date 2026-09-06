/* ============================================================
   ГОЛОВНИЙ ЗАМІР: RTP + bootstrap-довірчий інтервал.

   Бонуску прибрано — лишилась звичайна ставка. Виграш має важкий
   хвіст (блоки-множники, вікно множення), тому одна цифра нічого
   не варта — рахуємо CI ресемплінгом.

   npm run sim:final -- [ставок]
   ============================================================ */

import { CONFIG } from '../src/config';
import { resolveRound } from '../src/round';
import { sfc32 } from '../src/rng';
import { seedAt } from './seeds';

const N = parseInt(process.argv[2] || '80000', 10);
const CAP = CONFIG.maxWinX;
const TARGET = 0.95;

/* ---- вибірка сирих очок ---- */
const collected: number[] = [];
let withPick = 0;
for (let i = 0; i < N; i++) {
  const r = resolveRound(seedAt(i), 'bet', 1);
  if (r.setup.tiers.length) withPick++;
  collected.push(r.sim.collected);
}

const meanRTP = (K: number) =>
  collected.reduce((a, m) => a + Math.min(m / K, CAP), 0) / N;

/* payoutK, за якого RTP (зі стелею) = TARGET */
let Kfit = CONFIG.payoutK;
for (let i = 0; i < 400; i++) {
  const Kn = Kfit * meanRTP(Kfit) / TARGET;
  if (Math.abs(Kn - Kfit) / Kfit < 1e-9) break;
  Kfit = Kfit * 0.4 + Kn * 0.6;
}

const Kcur = CONFIG.payoutK;
const rtpCur = meanRTP(Kcur);

/* bootstrap CI на RTP при поточному K (детермінований потік) */
const rnd = sfc32(0x1234abcd, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35);
const boot: number[] = [];
for (let b = 0; b < 400; b++) {
  let s = 0;
  for (let i = 0; i < N; i++) s += Math.min(collected[(rnd() * N) | 0] / Kcur, CAP);
  boot.push(s / N);
}
boot.sort((a, b) => a - b);

const xs = collected.map((m) => m / Kcur).sort((a, b) => a - b);
const q = (x: number) => xs[Math.min(N - 1, Math.floor(N * x))];
const caps = collected.filter((m) => m / Kcur > CAP).length;

console.log('ставок:', N, '| кірка в', (100 * withPick / N).toFixed(1) + '% ставок');
console.log('payoutK у конфізі =', Kcur, '| для рівно 95% треба', Kfit.toFixed(0));
console.log('RTP при payoutK =', Kcur + ':', (rtpCur * 100).toFixed(2) + '%',
            '(95% CI ' + (boot[10] * 100).toFixed(2) + '..' + (boot[389] * 100).toFixed(2) + '%)');
console.log('квантилі виграшу: 50% x' + q(0.5).toFixed(2),
            '| 90% x' + q(0.9).toFixed(1),
            '| 99% x' + q(0.99).toFixed(0),
            '| 99.9% x' + q(0.999).toFixed(0),
            '| макс x' + xs[N - 1].toFixed(0));
console.log('стеля x' + CAP + ':', caps, 'спрацювань',
            caps ? '(раз на ' + Math.round(N / caps) + ')' : '(жодного)');
