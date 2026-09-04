/* Аналіз стелі виграшу: як часто спрацьовує, скільки RTP зрізає,
   з чим корелює. node sim/cap.js [ставок] [бонусок] */
const { CONFIG, TIERS, reelTable, bonusReelTable } = require('../js/config.js');
const World = require('../js/world.js');
const Run = require('../js/run.js');
const DT = 1 / 120, B = CONFIG.bonus, K = CONFIG.payoutK, CAP = CONFIG.maxWinX;
const NB = parseInt(process.argv[2] || '40000', 10);
const NX = parseInt(process.argv[3] || '8000', 10);

function playRun(tiers, bonus) {
  const mine = new World.Mine(CONFIG.cols, null, bonus);
  const run = new Run(tiers, mine);
  let g = 0; while (!run.over && g++ < 200000) { run.events.length = 0; run.step(DT); }
  return run;
}

/* звичайні ставки */
const bet = [];
for (let i = 0; i < NB; i++) {
  let x = 0;
  for (let s = 0; s < CONFIG.spinsPerBet; s++) {
    const it = World.pickItem(reelTable()).item;
    if (it.none) continue;
    x = playRun([it], false).collected / K;      // БЕЗ кепу
    break;
  }
  bet.push(x);
}

/* бонуски — записуємо ще й склад, щоб побачити з чим корелює кеп */
const bon = [];
for (let i = 0; i < NX; i++) {
  const tiers = [];
  for (let k = 0; k < B.spins; k++) {
    let it = World.pickItem(bonusReelTable()).item;
    const left = B.spins - k;
    if (it.none && tiers.length < B.guarantee && left <= B.guarantee - tiers.length) it = World.pickItem(TIERS);
    if (!it.none) tiers.push(it);
  }
  const run = playRun(tiers, true);
  bon.push({ x: run.collected / K, chain: run.multChain, picks: tiers.length,
             top: Math.max.apply(null, tiers.map(t => TIERS.indexOf(t))) });
}

function stats(name, xs, n) {
  const capped = xs.map(x => Math.min(x, CAP));
  const eU = xs.reduce((a, b) => a + b, 0) / n;
  const eC = capped.reduce((a, b) => a + b, 0) / n;
  const hits = xs.filter(x => x > CAP).length;
  const near = xs.filter(x => x > CAP * 0.5 && x <= CAP).length;
  console.log('\n=== ' + name + ' (n=' + n + ') ===');
  console.log('  кеп спрацював:', hits, '=', (hits / n * 100).toFixed(4) + '%',
              hits ? '(раз на ' + Math.round(n / hits) + ')' : '');
  console.log('  у зоні 2500..5000x:', near, '=', (near / n * 100).toFixed(4) + '%');
  console.log('  E без кепу x' + eU.toFixed(2), '| E з кепом x' + eC.toFixed(2),
              '| кеп зрізає', ((1 - eC / eU) * 100).toFixed(1) + '% віддачі');
  const s = xs.slice().sort((a, b) => a - b);
  console.log('  квантилі: 50% x' + s[n >> 1].toFixed(1),
              '| 99% x' + s[Math.floor(n * .99)].toFixed(0),
              '| 99.9% x' + s[Math.floor(n * .999)].toFixed(0),
              '| макс x' + s[n - 1].toFixed(0));
  return { eU, eC, hits };
}

const sb = stats('ЗВИЧАЙНІ СТАВКИ', bet, NB);
const sx = stats('БОНУСКИ', bon.map(b => b.x), NX);

/* з чим корелює кеп */
console.log('\n=== ЩО ТРЕБА, ЩОБ ПРОБИТИ 5000x У БОНУСЦІ ===');
const big = bon.filter(b => b.x > CAP);
const near = bon.filter(b => b.x > CAP * 0.2);
console.log('  бонусок >5000x:', big.length, '| >1000x:', near.length);
const show = (arr, label) => {
  if (!arr.length) return console.log('  ' + label + ': немає в цій вибірці');
  const ch = arr.map(b => b.chain).sort((a, b) => a - b);
  console.log('  ' + label + ': добуток множників медіана x' + ch[ch.length >> 1] +
              ' | мін x' + ch[0] + ' | кірок сер. ' + (arr.reduce((a, b) => a + b.picks, 0) / arr.length).toFixed(1) +
              ' | найкраща кірка сер. ' + (arr.reduce((a, b) => a + b.top, 0) / arr.length).toFixed(1) + '/5');
};
show(big, '>5000x');
show(near, '>1000x');
const noMult = bon.filter(b => b.chain === 1);
console.log('  бонусок узагалі без множників:', noMult.length, '=', (noMult.length / NX * 100).toFixed(1) + '%',
            '| з них макс x' + Math.max.apply(null, noMult.map(b => b.x)).toFixed(0));

/* внесок кепу в загальний RTP */
const f = 1 / 211;                                   // частота стріку, з sim/balance.js
console.log('\n=== ВПЛИВ КЕПУ НА RTP ===');
console.log('  RTP без кепу:', ((sb.eU + f * sx.eU) * 100).toFixed(1) + '%');
console.log('  RTP з кепом: ', ((sb.eC + f * sx.eC) * 100).toFixed(1) + '%');
console.log('  тобто кеп тримає', (((sb.eU + f * sx.eU) - (sb.eC + f * sx.eC)) * 100).toFixed(1) + ' п.п. RTP');
