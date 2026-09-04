/* Фактичний RTP гри при поточному payoutK: звичайні ставки,
   бонуски за стрік і куплені бонуски. Реальна фізика.
   node sim/balance.js [ставок] */
const { CONFIG, TIERS, reelTable, bonusReelTable } = require('../js/config.js');
const World = require('../js/world.js');
const Run = require('../js/run.js');

const N = parseInt(process.argv[2] || '15000', 10);
const DT = 1 / 120;
const B = CONFIG.bonus;

/* виплата в частках ставки (ставка = 1), зі стелею */
const pay = raw => Math.min(raw / CONFIG.payoutK, CONFIG.maxWinX);

function playRun(tiers, bonus) {
  const mine = new World.Mine(CONFIG.cols, null, bonus);
  const run = new Run(tiers, mine);
  let g = 0;
  while (!run.over && g++ < 200000) { run.events.length = 0; run.step(DT); }
  return run;
}

const st = { drops: 0, spins: 0, depth: 0, secs: 0, blocks: 0, baseMults: 0,
             bPicks: 0, bMults: 0, bSecs: 0, bRuns: 0, perTier: {} };
for (const t of TIERS) st.perTier[t.id] = { n: 0, sum: 0 };

function playBet() {
  for (let i = 0; i < CONFIG.spinsPerBet; i++) {
    const item = World.pickItem(reelTable()).item;
    st.spins++;
    if (item.none) continue;
    const run = playRun([item], false);
    st.drops++; st.depth += run.depth; st.secs += run.time;
    st.blocks += run.blocks; st.baseMults += run.mults;
    st.perTier[item.id].n++; st.perTier[item.id].sum += pay(run.collected);
    return { x: pay(run.collected), pick: true };
  }
  return { x: 0, pick: false };
}

function playBonus() {
  const tiers = [];
  for (let i = 0; i < B.spins; i++) {
    let item = World.pickItem(bonusReelTable()).item;
    const left = B.spins - i;
    if (item.none && tiers.length < B.guarantee && left <= B.guarantee - tiers.length)
      item = World.pickItem(TIERS);
    if (!item.none) tiers.push(item);
  }
  const run = playRun(tiers, true);
  st.bPicks += tiers.length; st.bMults += run.mults; st.bSecs += run.time; st.bRuns++;
  return pay(run.collected);
}

let baseX = 0, streakX = 0, streak = 0, triggers = 0, dry = 0, bestBet = 0, capHits = 0;
const betX = [];

for (let i = 0; i < N; i++) {
  const r = playBet();
  baseX += r.x; betX.push(r.x);
  if (r.x > bestBet) bestBet = r.x;
  if (r.x >= CONFIG.maxWinX) capHits++;
  if (!r.pick) dry++;

  if (r.pick) streak++; else streak = 0;
  if (streak >= B.streak) { streak = 0; triggers++; streakX += playBonus(); }
}

const M = Math.max(500, Math.round(N / 15));
let buyX = 0, bestBonus = 0;
const bonusX = [];
for (let i = 0; i < M; i++) { const x = playBonus(); buyX += x; bonusX.push(x); if (x > bestBonus) bestBonus = x; }

const eBase = baseX / N, eStreak = streakX / N, eBonus = buyX / M;
const sortedB = bonusX.slice().sort((a, b) => a - b);

console.log('=== ЗВИЧАЙНА ГРА ===');
console.log('ставок:', N, '| кірка в', ((st.drops / N) * 100).toFixed(1) + '% ставок',
            '(' + ((st.drops / st.spins) * 100).toFixed(1) + '% прокрутів)',
            '| без кірки:', ((dry / N) * 100).toFixed(1) + '%');
console.log('політ: глибина', (st.depth / st.drops).toFixed(1),
            '| блоків', (st.blocks / st.drops).toFixed(1),
            '| час', (st.secs / st.drops).toFixed(1) + 'с',
            '| Х-блоків', (st.baseMults / st.drops).toFixed(3));

console.log('\n=== БОНУСКА ===');
console.log('стрік', B.streak, 'спрацював', triggers, 'разів — раз на',
            (N / Math.max(1, triggers)).toFixed(0), 'ставок');
console.log('кірок у бонусці:', (st.bPicks / st.bRuns).toFixed(1),
            '| Х-блоків:', (st.bMults / st.bRuns).toFixed(2),
            '| час:', (st.bSecs / st.bRuns).toFixed(0) + 'с');
console.log('куплена бонуска: сер. x' + eBonus.toFixed(1),
            '| медіана x' + sortedB[sortedB.length >> 1].toFixed(1),
            '| макс x' + bestBonus.toFixed(0),
            '| ціна x' + B.buyCost, '=> RTP купівлі', ((eBonus / B.buyCost) * 100).toFixed(0) + '%');

console.log('\n=== RTP при payoutK =', CONFIG.payoutK, '===');
console.log('звичайна гра:', (eBase * 100).toFixed(1) + '%',
            '| бонуски за стрік:', (eStreak * 100).toFixed(1) + '%',
            '| РАЗОМ:', ((eBase + eStreak) * 100).toFixed(1) + '%');
/* Стрік спрацьовує рідко, тому пряма оцінка шумна.
   Точніше: частота стріку * вартість бонуски, виміряна на M зразках. */
const f = triggers / N;
const eStreakLV = f * eBonus;
console.log('точніша оцінка (частота стріку x вартість бонуски):',
            'бонуски', (eStreakLV * 100).toFixed(1) + '%',
            '| РАЗОМ', ((eBase + eStreakLV) * 100).toFixed(1) + '%');
console.log('макс за звичайну ставку x' + bestBet.toFixed(0),
            '| стеля x' + CONFIG.maxWinX + ' спрацювала', capHits, 'разів');

const names = ['0x (нічого)', '<0.5x', '0.5-1x', '1-2x', '2-5x', '5-20x', '20x+'];
const buckets = [0, 0, 0, 0, 0, 0, 0];
for (const x of betX)
  buckets[x === 0 ? 0 : x < 0.5 ? 1 : x < 1 ? 2 : x < 2 ? 3 : x < 5 ? 4 : x < 20 ? 5 : 6]++;
console.log('\nрозподіл звичайної ставки:');
buckets.forEach((b, i) => console.log('  ' + names[i].padEnd(12), ((b / N) * 100).toFixed(1) + '%'));

console.log('\nпо кірках (один політ):');
for (const t of TIERS) {
  const p = st.perTier[t.id];
  console.log('  ' + t.id.padEnd(8), 'HP', String(t.hp).padStart(3), 'урон', t.dmg,
              '| випала в', ((p.n / N) * 100).toFixed(2) + '% ставок',
              '| сер. виплата x' + (p.sum / Math.max(1, p.n)).toFixed(2));
}
