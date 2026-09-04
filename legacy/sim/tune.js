/* Підбір параметрів: частота Х-блоків, довжина стріку, payoutK.
   Стеля виграшу (CONFIG.maxWinX) робить RTP скінченним, тому K
   шукається ітеративно.
   node sim/tune.js [зразків] */
const { CONFIG, TIERS, reelTable, bonusReelTable } = require('../js/config.js');
const World = require('../js/world.js');
const Run = require('../js/run.js');

const S = parseInt(process.argv[2] || '2500', 10);
const DT = 1 / 120;
const B = CONFIG.bonus;
const CAP = CONFIG.maxWinX;
const TARGET = 0.95;

function playRun(tiers, bonus) {
  const mine = new World.Mine(CONFIG.cols, null, bonus);
  const run = new Run(tiers, mine);
  let g = 0;
  while (!run.over && g++ < 200000) { run.events.length = 0; run.step(DT); }
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
    if (it.none && tiers.length < B.guarantee && left <= B.guarantee - tiers.length)
      it = World.pickItem(TIERS);
    if (!it.none) tiers.push(it);
  }
  return playRun(tiers, true).collected;
}

/* Частка ставок, що запускають бонуску за стріком довжини n */
function streakFreq(picks, n) {
  let s = 0, trig = 0;
  for (const p of picks) { if (p) s++; else s = 0; if (s >= n) { s = 0; trig++; } }
  return trig / picks.length;
}

/* K такий, щоб загальний RTP = TARGET, з урахуванням стелі виграшу */
function solveK(base, bonus, f) {
  let K = 1000;
  for (let i = 0; i < 200; i++) {
    const eb = base.reduce((a, m) => a + Math.min(m / K, CAP), 0) / base.length;
    const ex = bonus.reduce((a, m) => a + Math.min(m / K, CAP), 0) / bonus.length;
    const rtp = eb + f * ex;
    const Kn = K * rtp / TARGET;
    if (!Number.isFinite(Kn) || Kn <= 0) return null;
    if (Math.abs(Kn - K) / K < 1e-6) return Kn;
    K = K * 0.4 + Kn * 0.6;
  }
  return K;
}

function report(base, bonus, picks, w) {
  console.log('\n### multWeight = ' + w + '   (Х-блоків у бонусній шахті)');
  console.log('  стрік | раз на N | K      | бонуска сер. | медіана | RTP купівлі | RTP звич.гри');
  for (const n of [3, 5, 8, 12]) {
    const f = streakFreq(picks, n);
    if (f === 0) { console.log(String(n).padStart(7), '| ніколи на цій вибірці'); continue; }
    const K = solveK(base, bonus, f);
    if (!K) { console.log(String(n).padStart(7), '| не сходиться'); continue; }
    const eb = base.reduce((a, m) => a + Math.min(m / K, CAP), 0) / base.length;
    const ex = bonus.reduce((a, m) => a + Math.min(m / K, CAP), 0) / bonus.length;
    const sorted = bonus.map(m => Math.min(m / K, CAP)).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    console.log(String(n).padStart(7), '|',
      (1 / f).toFixed(0).padStart(8), '|', K.toFixed(0).padStart(6), '|',
      ('x' + ex.toFixed(1)).padStart(12), '|', ('x' + med.toFixed(1)).padStart(7), '|',
      ((ex / B.buyCost) * 100).toFixed(0).padStart(10) + '%', '|',
      (eb * 100).toFixed(0) + '%');
  }
}

const base = [], picks = [];
for (let i = 0; i < S; i++) { const b = betRaw(); base.push(b.money); picks.push(b.pick); }
console.log('зразків ставок:', S, '| кірка в', ((picks.filter(Boolean).length / S) * 100).toFixed(1) + '% ставок');
console.log('ціна бонуски: x' + B.buyCost + ' | стеля виграшу: x' + CAP);

for (const w of [0.5, 1.0, 2.0]) {
  CONFIG.bonus.multWeight = w;
  const bonus = [];
  for (let i = 0; i < Math.max(250, S / 6); i++) bonus.push(bonusRaw());
  report(base, bonus, picks, w);
}
