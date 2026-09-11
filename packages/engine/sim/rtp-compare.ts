/* Порівняння RTP «до / після» правок фізики.

   Тимчасовий замір: той самий потік ставок, що в sim/final.ts, але
   прогнаний двічі — зі старими й новими числами фізики. Потрібен, щоб
   відрізнити «RTP поїхав від правки» від «RTP і був такий».

   CONFIG.phys / CONFIG.rubber мутуються на льоту: run.ts тримає
   посилання (const P = CONFIG.phys), тож правка доходить до фізики. */

import { CONFIG } from '../src/config';
import { resolveRound } from '../src/round';
import { roundSeed } from '../src/fairness';

const N = parseInt(process.argv[2] || '60000', 10);
const CAP = CONFIG.maxWinX;
const TARGET = 0.95;

const phys = CONFIG.phys as unknown as Record<string, number>;
const rubber = CONFIG.rubber as unknown as Record<string, number>;

const NEW = {
  phys: { restitution: 0.42, bounceKick: 2.8, friction: 0.12, comOffset: 0.18, spinInertia: 2.4, airDrag: 0.14 },
  rubber: { restitution: 0.95, minKick: 7, maxKick: 18, centerFrac: 0.5 },
};
const OLD = {
  phys: { restitution: 0.34, bounceKick: 1.4, friction: 0.16, comOffset: 0.15, spinInertia: 1.7, airDrag: 0.18 },
  // centerFrac > 1 = смуга ширша за шахту, тобто обмеження спавну вимкнене
  rubber: { restitution: 0.82, minKick: 5, maxKick: 13, centerFrac: 9 },
};

function run(label: string, v: typeof NEW) {
  Object.assign(phys, v.phys);
  Object.assign(rubber, v.rubber);

  const collected: number[] = [];
  let withPick = 0, dry = 0, blocks = 0, hits = 0;
  for (let i = 0; i < N; i++) {
    const seed = roundSeed('srv-final', 'cli', i + 1);
    const pity = dry >= CONFIG.pity;
    const r = resolveRound(seed, 'bet', 1, pity);
    const gotPick = r.setup.tiers.length > 0;
    if (gotPick) withPick++;
    dry = gotPick ? 0 : dry + 1;
    collected.push(r.sim.collected);
    blocks += r.sim.blocks; hits += r.sim.hits;
  }

  const meanRTP = (K: number) =>
    collected.reduce((a, m) => a + Math.min(m / K, CAP), 0) / N;

  let Kfit = CONFIG.payoutK;
  for (let i = 0; i < 500; i++) {
    const Kn = Kfit * meanRTP(Kfit) / TARGET;
    if (Math.abs(Kn - Kfit) / Kfit < 1e-9) break;
    Kfit = Kfit * 0.4 + Kn * 0.6;
  }

  console.log(
    label.padEnd(10)
    + ' RTP@' + CONFIG.payoutK + ' = ' + (meanRTP(CONFIG.payoutK) * 100).toFixed(2) + '%'
    + ' | payoutK для 95% ≈ ' + Kfit.toFixed(0)
    + ' | кірка ' + ((withPick / N) * 100).toFixed(1) + '%'
    + ' | блоків/забіг ' + (blocks / withPick).toFixed(0)
    + ' | ударів/забіг ' + (hits / withPick).toFixed(0));
}

console.log('ставок у кожному прогоні:', N);
run('ДО', OLD);
run('ПІСЛЯ', NEW);
