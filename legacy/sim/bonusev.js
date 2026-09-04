/* Точне середнє куплених бонусок — хвіст важкий, треба багато зразків.
   node sim/bonusev.js [зразків] */
const { CONFIG, TIERS, bonusReelTable } = require('../js/config.js');
const World = require('../js/world.js');
const Run = require('../js/run.js');
const N = parseInt(process.argv[2] || '6000', 10);
const DT = 1 / 120, B = CONFIG.bonus;
const pay = raw => Math.min(raw / CONFIG.payoutK, CONFIG.maxWinX);

const xs = [];
for (let i = 0; i < N; i++) {
  const tiers = [];
  for (let k = 0; k < B.spins; k++) {
    let it = World.pickItem(bonusReelTable()).item;
    const left = B.spins - k;
    if (it.none && tiers.length < B.guarantee && left <= B.guarantee - tiers.length) it = World.pickItem(TIERS);
    if (!it.none) tiers.push(it);
  }
  const mine = new World.Mine(CONFIG.cols, null, true);
  const run = new Run(tiers, mine);
  let g = 0; while (!run.over && g++ < 200000) { run.events.length = 0; run.step(DT); }
  xs.push(pay(run.collected));
}
xs.sort((a, b) => a - b);
const mean = xs.reduce((a, b) => a + b, 0) / N;
const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / N);
const se = sd / Math.sqrt(N);
console.log('зразків:', N, '| payoutK =', CONFIG.payoutK);
console.log('E[бонуска] = x' + mean.toFixed(1), '+- ' + (1.96 * se).toFixed(1), '(95% дов.)');
console.log('медіана x' + xs[N >> 1].toFixed(1),
            '| 25% x' + xs[Math.floor(N * .25)].toFixed(1),
            '| 90% x' + xs[Math.floor(N * .9)].toFixed(1),
            '| 99% x' + xs[Math.floor(N * .99)].toFixed(0),
            '| макс x' + xs[N - 1].toFixed(0));
console.log('ціна x' + B.buyCost + ' => RTP купівлі', ((mean / B.buyCost) * 100).toFixed(1) + '%');
console.log('частка бонусок, що окупили ціну:',
            ((xs.filter(x => x >= B.buyCost).length / N) * 100).toFixed(1) + '%');
