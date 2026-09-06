/* ============================================================
   ГОЛОВНИЙ ЗАМІР: RTP + bootstrap-довірчий інтервал.

   Симулюємо ПОСЛІДОВНИЙ потік ставок одного гравця: pity-лічильник
   (CONFIG.pity пустих ставок поспіль -> наступна форсить кірку)
   веде себе так само, як на сервері.

   npm run sim:final -- [ставок]
   ============================================================ */

import { CONFIG } from '../src/config';
import { resolveRound } from '../src/round';
import { sfc32 } from '../src/rng';
import { roundSeed } from '../src/fairness';

const N = parseInt(process.argv[2] || '200000', 10);
const CAP = CONFIG.maxWinX;
const TARGET = 0.95;

/* ---- послідовний потік ставок, ставка = 1 ---- */
const collected: number[] = [];
let withPick = 0, pityRounds = 0, pityConverted = 0, dry = 0;

for (let i = 0; i < N; i++) {
  const seed = roundSeed('srv-final', 'cli', i + 1);
  const pity = dry >= CONFIG.pity;
  const r = resolveRound(seed, 'bet', 1, pity);
  const gotPick = r.setup.tiers.length > 0;

  if (pity) { pityRounds++; if (gotPick) pityConverted++; }
  if (gotPick) withPick++;
  dry = gotPick ? 0 : dry + 1;

  collected.push(r.sim.collected);
}

const meanRTP = (K: number) =>
  collected.reduce((a, m) => a + Math.min(m / K, CAP), 0) / N;

/* payoutK, за якого RTP (зі стелею) = TARGET */
let Kfit = CONFIG.payoutK;
for (let i = 0; i < 500; i++) {
  const Kn = Kfit * meanRTP(Kfit) / TARGET;
  if (Math.abs(Kn - Kfit) / Kfit < 1e-9) break;
  Kfit = Kfit * 0.4 + Kn * 0.6;
}

const Kcur = CONFIG.payoutK;
const rtpCur = meanRTP(Kcur);
const rtpFit = meanRTP(Kfit);

/* bootstrap CI на RTP при payoutK = Kfit (детермінований потік) */
const rnd = sfc32(0x1234abcd, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35);
const boot: number[] = [];
for (let b = 0; b < 400; b++) {
  let s = 0;
  for (let i = 0; i < N; i++) s += Math.min(collected[(rnd() * N) | 0] / Kfit, CAP);
  boot.push(s / N);
}
boot.sort((a, b) => a - b);

const xs = collected.map((m) => m / Kfit).sort((a, b) => a - b);
const q = (x: number) => xs[Math.min(N - 1, Math.floor(N * x))];
const caps = collected.filter((m) => m / Kfit > CAP).length;
const hitRate = withPick / N;

console.log('ставок:', N);
console.log('кірка (з pity):', (hitRate * 100).toFixed(2) + '%  =  раз на',
            (1 / hitRate).toFixed(1), 'ставок');
console.log('pity спрацював', pityRounds, 'разів (' + (pityRounds / N * 100).toFixed(1) + '%),',
            'з них кірку дав', pityConverted);
console.log('');
console.log('payoutK у конфізі =', Kcur, ' RTP при ньому:', (rtpCur * 100).toFixed(2) + '%');
console.log('payoutK для 95%   ≈', Math.round(Kfit), ' (перевірка RTP:', (rtpFit * 100).toFixed(2) + '%,',
            'CI ' + (boot[10] * 100).toFixed(2) + '..' + (boot[389] * 100).toFixed(2) + '%)');
console.log('');
console.log('квантилі виграшу @ payoutK', Math.round(Kfit) + ':',
            '50% x' + q(0.5).toFixed(2),
            '| 90% x' + q(0.9).toFixed(1),
            '| 95% x' + q(0.95).toFixed(1),
            '| 99% x' + q(0.99).toFixed(0),
            '| 99.9% x' + q(0.999).toFixed(0),
            '| макс x' + xs[N - 1].toFixed(0));
console.log('стеля x' + CAP + ':', caps, 'спрацювань',
            caps ? '(раз на ' + Math.round(N / caps) + ')' : '(жодного)');
