/* Порівняння варіантів таблиці множників: хвіст, кеп, EV.
   node sim/multtest.js [зразків бонусок] */
const cfg = require('../js/config.js');
const { CONFIG, TIERS, reelTable, bonusReelTable } = cfg;
const World = require('../js/world.js');
const Run = require('../js/run.js');
const N = parseInt(process.argv[2] || '4000', 10);
const DT = 1 / 120, B = CONFIG.bonus, CAP = CONFIG.maxWinX;

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
  return { raw: r.collected, chain: r.multChain, mults: r.mults };
}
function betRaw() {
  for (let s = 0; s < CONFIG.spinsPerBet; s++) {
    const it = World.pickItem(reelTable()).item;
    if (it.none) continue;
    return playRun([it], false).collected;
  }
  return 0;
}

/* базові ставки — не залежать від бонусної таблиці, міряємо раз */
const NB = 15000;
const base = [];
for (let i = 0; i < NB; i++) base.push(betRaw());
const f = 1 / 211;                                   // частота стріку

const VARIANTS = [
  { name: 'ПОТОЧНА (з x25 і x100)', w: 0.3,
    table: [{m:2,weight:60},{m:3,weight:25},{m:5,weight:9},{m:10,weight:4},
            {m:15,weight:1.5},{m:25,weight:0.45},{m:100,weight:0.05}] },
  { name: 'БЕЗ x25/x100, та сама частота', w: 0.3,
    table: [{m:2,weight:58},{m:3,weight:26},{m:5,weight:11},{m:10,weight:4},{m:15,weight:1}] },
  { name: 'БЕЗ x25/x100, частіші', w: 0.6,
    table: [{m:2,weight:58},{m:3,weight:26},{m:5,weight:11},{m:10,weight:4},{m:15,weight:1}] },
  { name: 'БЕЗ x25/x100, ще частіші', w: 1.0,
    table: [{m:2,weight:62},{m:3,weight:26},{m:5,weight:9},{m:10,weight:3}] }
];

console.log('базових ставок:', NB, '| бонусок на варіант:', N, '| стрік раз на 211 ставок\n');

for (const v of VARIANTS) {
  CONFIG.bonus.multTable = v.table;
  CONFIG.bonus.multWeight = v.w;
  const xs = [], chains = [];
  let noMult = 0;
  for (let i = 0; i < N; i++) {
    const r = bonusRaw();
    xs.push(r.raw); chains.push(r.chain);
    if (r.mults === 0) noMult++;
  }
  const ms = v.table.reduce((a, b) => a + b.weight, 0);
  const Em = v.table.reduce((a, b) => a + b.m * b.weight, 0) / ms;

  /* K такий, щоб загальний RTP (з кепом) = 95% */
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
  const capped = xs.filter(m => m / K > CAP).length;
  const s = xs.map(m => m / K).sort((a, b) => a - b);
  const ch = chains.slice().sort((a, b) => a - b);

  console.log('### ' + v.name + '   multWeight=' + v.w + '  E[ікс]=' + Em.toFixed(2));
  console.log('   payoutK =', K.toFixed(0), '| RTP звич.', (eb * 100).toFixed(1) + '%',
              '| бонуски', (f * exC * 100).toFixed(1) + '%', '| разом', ((eb + f * exC) * 100).toFixed(1) + '%');
  console.log('   бонуска: E з кепом x' + exC.toFixed(1), '| без кепу x' + exU.toFixed(1),
              '=> КЕП ЗРІЗАЄ', ((1 - exC / exU) * 100).toFixed(1) + '% =',
              ((exU - exC) * f * 100).toFixed(2) + ' п.п. RTP');
  console.log('   кеп спрацював', capped, '=', (capped / N * 100).toFixed(3) + '%',
              '| RTP купівлі', ((exC / B.buyCost) * 100).toFixed(0) + '%');
  console.log('   квантилі x: 50%', s[N >> 1].toFixed(1), '| 90%', s[Math.floor(N * .9)].toFixed(0),
              '| 99%', s[Math.floor(N * .99)].toFixed(0), '| 99.9%', s[Math.floor(N * .999)].toFixed(0),
              '| макс', s[N - 1].toFixed(0));
  console.log('   без множників', (noMult / N * 100).toFixed(1) + '%',
              '| ланцюг: медіана x' + ch[N >> 1], '| 99% x' + ch[Math.floor(N * .99)],
              '| макс x' + ch[N - 1], '\n');
}
