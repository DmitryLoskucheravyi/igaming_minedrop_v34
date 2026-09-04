/* Фінальний замір із bootstrap-довірчими інтервалами.
   Оцінка E[бонуска] має важкий хвіст, тому одна цифра нічого не варта —
   рахуємо CI ресемплінгом. node sim/final.js [ставок] [бонусок] */
const { CONFIG, TIERS, reelTable, bonusReelTable } = require('../js/config.js');
const World = require('../js/world.js');
const Run = require('../js/run.js');
const NB = parseInt(process.argv[2] || '40000', 10);
const NX = parseInt(process.argv[3] || '15000', 10);
const DT = 1 / 120, B = CONFIG.bonus, CAP = CONFIG.maxWinX, f = 1 / 211;

function playRun(tiers, bonus) {
  const mine = new World.Mine(CONFIG.cols, null, bonus);
  const run = new Run(tiers, mine);
  let g = 0; while (!run.over && g++ < 200000) { run.events.length = 0; run.step(DT); }
  return run;
}
const base = [];
for (let i = 0; i < NB; i++) {
  let x = 0;
  for (let s = 0; s < CONFIG.spinsPerBet; s++) {
    const it = World.pickItem(reelTable()).item;
    if (it.none) continue;
    x = playRun([it], false).collected; break;
  }
  base.push(x);
}
const bon = [];
for (let i = 0; i < NX; i++) {
  const tiers = [];
  for (let k = 0; k < B.spins; k++) {
    let it = World.pickItem(bonusReelTable()).item;
    const left = B.spins - k;
    if (it.none && tiers.length < B.guarantee && left <= B.guarantee - tiers.length) it = World.pickItem(TIERS);
    if (!it.none) tiers.push(it);
  }
  bon.push(playRun(tiers, true).collected);
}

/* K, за якого загальний RTP (зі стелею) = 95% */
function solveK(bs, xs) {
  let K = 600;
  for (let i = 0; i < 400; i++) {
    const eb = bs.reduce((a, m) => a + Math.min(m / K, CAP), 0) / bs.length;
    const ex = xs.reduce((a, m) => a + Math.min(m / K, CAP), 0) / xs.length;
    const Kn = K * (eb + f * ex) / 0.95;
    if (Math.abs(Kn - K) / K < 1e-8) return Kn;
    K = K * 0.4 + Kn * 0.6;
  }
  return K;
}
const K = solveK(base, bon);
const eb = base.reduce((a, m) => a + Math.min(m / K, CAP), 0) / NB;
const exC = bon.reduce((a, m) => a + Math.min(m / K, CAP), 0) / NX;
const exU = bon.reduce((a, m) => a + m / K, 0) / NX;
const caps = bon.filter(m => m / K > CAP).length;

/* bootstrap: 400 ресемплів бонусної вибірки */
const boot = [];
for (let b = 0; b < 400; b++) {
  let s = 0;
  for (let i = 0; i < NX; i++) s += Math.min(bon[(Math.random() * NX) | 0] / K, CAP);
  boot.push(s / NX);
}
boot.sort((a, b) => a - b);
const lo = boot[Math.floor(400 * 0.025)], hi = boot[Math.floor(400 * 0.975)];

const s = bon.map(m => m / K).sort((a, b) => a - b);
console.log('ставок:', NB, '| бонусок:', NX, '| payoutK =', K.toFixed(0));
console.log('\nRTP: звичайна', (eb * 100).toFixed(1) + '%',
            '| бонуски', (f * exC * 100).toFixed(1) + '%',
            '| РАЗОМ', ((eb + f * exC) * 100).toFixed(1) + '%');
console.log('E[бонуска] = x' + exC.toFixed(1),
            '(95% CI: x' + lo.toFixed(1) + ' .. x' + hi.toFixed(1) + ', ширина ' +
            ((hi - lo) / exC * 100).toFixed(0) + '%)');
console.log('RTP купівлі за ціни x' + B.buyCost + ':', ((exC / B.buyCost) * 100).toFixed(0) + '%',
            '(CI ' + ((lo / B.buyCost) * 100).toFixed(0) + '..' + ((hi / B.buyCost) * 100).toFixed(0) + '%)');
console.log('\nСТЕЛЯ:', caps, 'спрацювань =', (caps / NX * 100).toFixed(3) + '%',
            caps ? '(раз на ' + Math.round(NX / caps) + ' бонусок)' : '');
console.log('  E без кепу x' + exU.toFixed(1), '| з кепом x' + exC.toFixed(1),
            '=> зрізає', ((1 - exC / exU) * 100).toFixed(1) + '% віддачі =',
            ((exU - exC) * f * 100).toFixed(2) + ' п.п. RTP');
console.log('\nквантилі бонуски: 50% x' + s[NX >> 1].toFixed(1),
            '| 90% x' + s[Math.floor(NX * .9)].toFixed(0),
            '| 99% x' + s[Math.floor(NX * .99)].toFixed(0),
            '| 99.9% x' + s[Math.floor(NX * .999)].toFixed(0),
            '| макс x' + s[NX - 1].toFixed(0));
console.log('окупають ціну x' + B.buyCost + ':', (s.filter(x => x >= B.buyCost).length / NX * 100).toFixed(1) + '%');
