/* Догін RTP купівлі щедрістю бонусної рулетки (не множниками).
   node sim/tune3.js */
const { CONFIG, TIERS, reelTable, bonusReelTable } = require('../js/config.js');
const World = require('../js/world.js');
const Run = require('../js/run.js');
const DT = 1 / 120, B = CONFIG.bonus, CAP = CONFIG.maxWinX, f = 1 / 211;

CONFIG.bonus.multTable = [{m:2,weight:58},{m:3,weight:26},{m:5,weight:11},{m:10,weight:4},{m:15,weight:1}];
CONFIG.bonus.multWeight = 0.3;

function playRun(tiers, bonus) {
  const mine = new World.Mine(CONFIG.cols, null, bonus);
  const run = new Run(tiers, mine);
  let g = 0; while (!run.over && g++ < 200000) { run.events.length = 0; run.step(DT); }
  return run;
}
function bonusRaw() {
  const tiers = [];
  for (let k = 0; k < B.spins; k++) {
    let it = World.pickItem(bonusReelTable()).item;
    const left = B.spins - k;
    if (it.none && tiers.length < B.guarantee && left <= B.guarantee - tiers.length) it = World.pickItem(TIERS);
    if (!it.none) tiers.push(it);
  }
  const r = playRun(tiers, true);
  return { raw: r.collected, picks: tiers.length };
}
function betRaw() {
  for (let s = 0; s < CONFIG.spinsPerBet; s++) {
    const it = World.pickItem(reelTable()).item;
    if (it.none) continue;
    return playRun([it], false).collected;
  }
  return 0;
}

const NB = 15000, N = 3500;
const base = [];
for (let i = 0; i < NB; i++) base.push(betRaw());
console.log('базових ставок:', NB, '| бонусок на варіант:', N, '\n');
console.log('пусто | boost | кірок |   K   | RTP звич | бонуски | разом | RTP купівлі | кеп зрізає | макс x');

for (const [rn, tb] of [[20, 1.75], [20, 2.2], [12, 1.75], [12, 2.0], [7, 1.75]]) {
  CONFIG.bonus.reelNothing = rn; CONFIG.bonus.tierBoost = tb;
  const xs = [], ps = [];
  for (let i = 0; i < N; i++) { const r = bonusRaw(); xs.push(r.raw); ps.push(r.picks); }
  let K = 600;
  for (let i = 0; i < 300; i++) {
    const eb = base.reduce((a, m) => a + Math.min(m / K, CAP), 0) / NB;
    const ex = xs.reduce((a, m) => a + Math.min(m / K, CAP), 0) / N;
    const Kn = K * (eb + f * ex) / 0.95;
    if (Math.abs(Kn - K) / K < 1e-7) { K = Kn; break; }
    K = K * 0.4 + Kn * 0.6;
  }
  const eb = base.reduce((a, m) => a + Math.min(m / K, CAP), 0) / NB;
  const exC = xs.reduce((a, m) => a + Math.min(m / K, CAP), 0) / N;
  const exU = xs.reduce((a, m) => a + m / K, 0) / N;
  const s = xs.map(m => m / K).sort((a, b) => a - b);
  console.log(String(rn).padStart(5), '|', String(tb).padStart(5), '|',
    (ps.reduce((a, b) => a + b, 0) / N).toFixed(1).padStart(5), '|', K.toFixed(0).padStart(5), '|',
    (eb * 100).toFixed(1).padStart(7) + '%', '|', (f * exC * 100).toFixed(1).padStart(6) + '%', '|',
    ((eb + f * exC) * 100).toFixed(1) + '%', '|',
    ((exC / B.buyCost) * 100).toFixed(0).padStart(10) + '%', '|',
    ((1 - exC / exU) * 100).toFixed(1).padStart(9) + '%', '|', s[N - 1].toFixed(0));
}
