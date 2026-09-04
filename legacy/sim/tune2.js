/* Прицільний підбір: шукаємо (tierBoost, multWeight) так, щоб
   куплена бонуска віддавала ~95% своєї ціни, а звичайна гра лишалась живою.
   node sim/tune2.js [зразків] */
const { CONFIG, TIERS, reelTable, bonusReelTable } = require('../js/config.js');
const World = require('../js/world.js');
const Run = require('../js/run.js');
const S = parseInt(process.argv[2] || '2000', 10);
const DT = 1 / 120, B = CONFIG.bonus, CAP = CONFIG.maxWinX, TARGET = 0.95;

function playRun(tiers, bonus) {
  const mine = new World.Mine(CONFIG.cols, null, bonus);
  const run = new Run(tiers, mine);
  let g = 0; while (!run.over && g++ < 200000) { run.events.length = 0; run.step(DT); }
  return run;
}
function betRaw() {
  for (let i = 0; i < CONFIG.spinsPerBet; i++) {
    const it = World.pickItem(reelTable()).item;
    if (it.none) continue;
    return { money: playRun([it], false).collected, pick: true };
  }
  return { money: 0, pick: false };
}
function bonusRaw() {
  const tiers = [];
  for (let i = 0; i < B.spins; i++) {
    let it = World.pickItem(bonusReelTable()).item;
    const left = B.spins - i;
    if (it.none && tiers.length < B.guarantee && left <= B.guarantee - tiers.length) it = World.pickItem(TIERS);
    if (!it.none) tiers.push(it);
  }
  const r = playRun(tiers, true);
  return { money: r.collected, picks: tiers.length };
}
function streakFreq(picks, n) {
  let s = 0, trig = 0;
  for (const p of picks) { if (p) s++; else s = 0; if (s >= n) { s = 0; trig++; } }
  return trig / picks.length;
}
function solveK(base, bonus, f) {
  let K = 1000;
  for (let i = 0; i < 300; i++) {
    const eb = base.reduce((a, m) => a + Math.min(m / K, CAP), 0) / base.length;
    const ex = bonus.reduce((a, m) => a + Math.min(m / K, CAP), 0) / bonus.length;
    const Kn = K * (eb + f * ex) / TARGET;
    if (!Number.isFinite(Kn) || Kn <= 0) return null;
    if (Math.abs(Kn - K) / K < 1e-7) return Kn;
    K = K * 0.4 + Kn * 0.6;
  }
  return K;
}

const base = [], picks = [];
for (let i = 0; i < S; i++) { const b = betRaw(); base.push(b.money); picks.push(b.pick); }
const STREAK = +(process.env.STREAK || 12);
const f = streakFreq(picks, STREAK);
console.log('стрік', STREAK, '-> раз на', (1 / f).toFixed(0), 'ставок | кірка в',
            ((picks.filter(Boolean).length / S) * 100).toFixed(1) + '% ставок\n');
console.log('boost | multW |   K   | кірок | бонуска сер | медіана | RTP купівлі | RTP звич.');

for (const tb of [1.5, 1.75, 2.0]) {
  for (const mw of [0.15, 0.3, 0.5]) {
    CONFIG.bonus.tierBoost = tb; CONFIG.bonus.multWeight = mw;
    const bs = [], bonus = [];
    for (let i = 0; i < Math.max(280, S / 6); i++) { const r = bonusRaw(); bonus.push(r.money); bs.push(r.picks); }
    const K = solveK(base, bonus, f);
    if (!K) { console.log(tb, mw, 'не сходиться'); continue; }
    const eb = base.reduce((a, m) => a + Math.min(m / K, CAP), 0) / base.length;
    const ex = bonus.reduce((a, m) => a + Math.min(m / K, CAP), 0) / bonus.length;
    const sorted = bonus.map(m => Math.min(m / K, CAP)).sort((a, b) => a - b);
    console.log(String(tb).padStart(5), '|', String(mw).padStart(5), '|', K.toFixed(0).padStart(6), '|',
      (bs.reduce((a, b) => a + b, 0) / bs.length).toFixed(1).padStart(5), '|',
      ('x' + ex.toFixed(1)).padStart(11), '|', ('x' + sorted[sorted.length >> 1].toFixed(1)).padStart(7), '|',
      ((ex / B.buyCost) * 100).toFixed(0).padStart(10) + '%', '|', (eb * 100).toFixed(0) + '%');
  }
}
