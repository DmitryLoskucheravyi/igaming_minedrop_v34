/* Інваріанти фізики та логіки. node sim/smoke.js [забігів] */
const { CONFIG, TIERS, BLOCKS } = require('../js/config.js');
const World = require('../js/world.js');
const Run = require('../js/run.js');

const N = parseInt(process.argv[2] || '3000', 10);
const DT = 1 / 120;
const R = CONFIG.phys.bodyR;

let bad = 0;
const seen = new Set();
const t = (c, m) => { if (!c) { if (!seen.has(m)) { console.log('FAIL:', m); seen.add(m); } bad++; } };

let totalHits = 0, totalBlocks = 0, mults = 0, bonusRuns = 0;

for (let i = 0; i < N; i++) {
  const isBonus = i % 5 === 0;                       // кожен п'ятий забіг — бонусний
  const mine = new World.Mine(CONFIG.cols, null, isBonus);
  const tiers = isBonus
    ? Array.from({ length: 1 + Math.floor(Math.random() * 5) }, () => World.pickItem(TIERS))
    : [World.pickItem(TIERS)];
  const run = new Run(tiers, mine);
  if (isBonus) bonusRuns++;

  t(run.picks.length === tiers.length, 'кірок у забігу не стільки, скільки замовили');

  let steps = 0, lastDepth = 0, lastCollected = 0, lastLevels = run.picks.map(p => p.level);

  while (!run.over && steps++ < 100000) {
    run.step(DT);

    for (const p of run.picks) {
      t(Number.isFinite(p.x) && Number.isFinite(p.y), 'NaN у координатах');
      t(Number.isFinite(p.vx) && Number.isFinite(p.vy), 'NaN у швидкості');
      t(p.x >= R - 1e-6 && p.x <= CONFIG.cols - R + 1e-6, 'кірка вийшла за стінки шахти: x=' + p.x);
      t(p.hp <= p.hpMax, 'HP більше за максимум');
    }
    t(run.collected >= 0, 'відʼємний рахунок');
    t(run.depth >= lastDepth - 1e-9, 'глибина зменшилась');
    run.picks.forEach((p, k) => t(p.level >= lastLevels[k], 'рівень кірки впав'));
    lastDepth = run.depth;

    for (const e of run.events) {
      if (e.t === 'break' || e.t === 'magic' || e.t === 'tnt' || e.t === 'mult')
        t(mine.get(e.r, e.c) === null, 'блок не прибрався з сітки після ' + e.t);

      if (e.t === 'crack') {
        // при кількох кірках сусідня могла добити цей самий блок у цьому ж кроці,
        // тому стан клітинки перевіряємо лише коли кірка одна
        if (run.picks.length === 1) {
          const cell = mine.get(e.r, e.c);
          t(cell && cell !== World.WALL, 'тріщина на порожній клітинці');
          t(cell && cell.dmg === e.stage, 'накопичений урон не збігається з подією');
        }
        t(e.stage < e.of, 'блок мав розколотись, а лишився');
        t(e.of === BLOCKS[e.id].tough, 'невірна міцність у події');
        // земля, камінь, динаміт і множники падають з першого удару — тріщин у них не буває
        t(BLOCKS[e.id].tough > 1, 'блок ' + e.id + ' тріснув, хоча має падати з одного удару');
      }

      if (e.t === 'mult') {
        mults++;
        t(CONFIG.bonus.multTable.some(x => x.m === e.m), 'невідомий множник x' + e.m);
        // множить УЖЕ накопичене, тому рахунок стрибає рівно в m разів
        t(Math.abs(e.total - e.before * e.m) < 1e-6,
          'множник спрацював не на накопичений виграш: ' + e.before + ' x' + e.m + ' -> ' + e.total);
      }
      if (e.t === 'magic') t(run.picks.some(q => q.enchanted), 'верстак не зачарував жодної кірки');
      if (e.t === 'tnt') for (const h of e.hit) t(BLOCKS[h.id].kind === 'solid', 'вибух зачепив не той блок');
    }
    lastCollected = run.collected;
    lastLevels = run.picks.map(p => p.level);
    run.events.length = 0;
  }

  t(run.over, 'забіг не завершився за 100000 кроків');
  t(run.reason !== null, 'немає причини завершення');
  t(run.reason !== 'broken' || run.picks.every(p => p.hp <= 0), 'reason=broken, але не всі кірки зламані');
  // TNT розносить до 8 сусідів за один удар, тому blocks може перегнати hits саме на стільки
  t(run.blocks <= run.hits + run.tnts * 8, 'розколото більше блоків, ніж дозволяють удари + вибухи');
  t(mine.rows.size < 8000, 'сітка розрослась: ' + mine.rows.size);

  totalHits += run.hits; totalBlocks += run.blocks;
}

console.log('забігів:', N, '(з них бонусних:', bonusRuns + ')');
console.log('ударів на забіг:', (totalHits / N).toFixed(1),
            '| розколото блоків:', (totalBlocks / N).toFixed(1),
            '| множників спіймано:', mults);
console.log(bad === 0 ? 'ALL INVARIANTS OK' : bad + ' failures');
process.exit(bad ? 1 : 0);
