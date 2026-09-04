/* ============================================================
   ГОЛОВНИЙ ЗАМІР: RTP + bootstrap-довірчі інтервали.

   Оцінка E[бонуска] має важкий хвіст, тому одна цифра нічого не
   варта — рахуємо CI ресемплінгом.

   Частота бонуски НЕ хардкодиться. Стрік — це процес відновлення:
   потрібно k ставок ПІДРЯД із кіркою, після спрацювання лічильник
   обнуляється. Середнє очікування = (1 - p^k) / (p^k * (1 - p)),
   де p — частка ставок із кіркою. p міряємо тут же.

   npm run sim:final -- [ставок] [бонусок]
   ============================================================ */

import { CONFIG } from '../src/config';
import { resolveRound } from '../src/round';
import { seedAt } from './seeds';

const NB = parseInt(process.argv[2] || '40000', 10);
const NX = parseInt(process.argv[3] || '15000', 10);
const CAP = CONFIG.maxWinX;
const B = CONFIG.bonus;

/* ---- вибірки сирих очок ---- */
const base: number[] = [];
let withPick = 0;
for (let i = 0; i < NB; i++) {
  const r = resolveRound(seedAt(i), 'bet', 1);
  if (r.setup.tiers.length) withPick++;
  base.push(r.sim.collected);
}

const bon: number[] = [];
for (let i = 0; i < NX; i++) {
  bon.push(resolveRound(seedAt(1_000_000 + i), 'bonus-buy', 1).sim.collected);
}

/* ---- частота бонуски за стріком ---- */
const p = withPick / NB;
const k = B.streak;
const pk = Math.pow(p, k);
const waitBets = (1 - pk) / (pk * (1 - p));
const f = 1 / waitBets;

/* ---- метрики ---- */
const meanCapped = (xs: number[], K: number) =>
  xs.reduce((a, m) => a + Math.min(m / K, CAP), 0) / xs.length;

/* K, за якого загальний RTP (зі стелею) = 95% */
function solveK(bs: number[], xs: number[]): number {
  let K = CONFIG.payoutK;
  for (let i = 0; i < 400; i++) {
    const Kn = K * (meanCapped(bs, K) + f * meanCapped(xs, K)) / 0.95;
    if (Math.abs(Kn - K) / K < 1e-8) return Kn;
    K = K * 0.4 + Kn * 0.6;
  }
  return K;
}

const Kcur = CONFIG.payoutK;
const Kfit = solveK(base, bon);

const ebCur = meanCapped(base, Kcur);
const exCur = meanCapped(bon, Kcur);
const exU = bon.reduce((a, m) => a + m / Kcur, 0) / NX;
const caps = bon.filter((m) => m / Kcur > CAP).length;

/* bootstrap: 400 ресемплів бонусної вибірки (детермінований потік) */
import { sfc32 } from '../src/rng';
const brnd = sfc32(0x1234abcd, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35);
const boot: number[] = [];
for (let b = 0; b < 400; b++) {
  let s = 0;
  for (let i = 0; i < NX; i++) s += Math.min(bon[(brnd() * NX) | 0] / Kcur, CAP);
  boot.push(s / NX);
}
boot.sort((a, b) => a - b);
const lo = boot[Math.floor(400 * 0.025)];
const hi = boot[Math.floor(400 * 0.975)];

const s = bon.map((m) => m / Kcur).sort((a, b) => a - b);
const q = (x: number) => s[Math.min(NX - 1, Math.floor(NX * x))];

console.log('ставок:', NB, '| бонусок:', NX);
console.log('payoutK у конфізі =', Kcur, '| для рівно 95% треба', Kfit.toFixed(0));
console.log('\nкірка в', (p * 100).toFixed(1) + '% ставок  ->  стрік', k,
            'спрацьовує раз на', waitBets.toFixed(0), 'ставок (f =', f.toExponential(2) + ')');
console.log('\nRTP при payoutK =', Kcur + ':',
            'звичайна', (ebCur * 100).toFixed(1) + '%',
            '| бонуски', (f * exCur * 100).toFixed(1) + '%',
            '| РАЗОМ', ((ebCur + f * exCur) * 100).toFixed(1) + '%');
console.log('E[бонуска] = x' + exCur.toFixed(1),
            '(95% CI: x' + lo.toFixed(1) + ' .. x' + hi.toFixed(1) + ', ширина ' +
            ((hi - lo) / exCur * 100).toFixed(0) + '%)');
console.log('RTP купівлі за ціни x' + B.buyCost + ':', ((exCur / B.buyCost) * 100).toFixed(0) + '%',
            '(CI ' + ((lo / B.buyCost) * 100).toFixed(0) + '..' + ((hi / B.buyCost) * 100).toFixed(0) + '%)');
console.log('\nСТЕЛЯ:', caps, 'спрацювань =', (caps / NX * 100).toFixed(3) + '%',
            caps ? '(раз на ' + Math.round(NX / caps) + ' бонусок)' : '');
console.log('  E без кепу x' + exU.toFixed(1), '| з кепом x' + exCur.toFixed(1),
            '=> зрізає', ((1 - exCur / exU) * 100).toFixed(1) + '% віддачі =',
            ((exU - exCur) * f * 100).toFixed(2) + ' п.п. RTP');
console.log('\nквантилі бонуски: 50% x' + q(0.5).toFixed(1),
            '| 90% x' + q(0.9).toFixed(0),
            '| 99% x' + q(0.99).toFixed(0),
            '| 99.9% x' + q(0.999).toFixed(0),
            '| макс x' + s[NX - 1].toFixed(0));
console.log('окупають ціну x' + B.buyCost + ':', (s.filter((x) => x >= B.buyCost).length / NX * 100).toFixed(1) + '%');
