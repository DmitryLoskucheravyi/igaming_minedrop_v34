/* Інваріанти фізики та логіки. npm run sim:smoke -- [забігів] */
import { BLOCKS, CONFIG } from '../src/config';
import { buildSetup, createRun } from '../src/round';
import { isWall } from '../src/world';
import { seedAt } from './seeds';

const N = parseInt(process.argv[2] || '3000', 10);
const R = CONFIG.phys.bodyR;

let bad = 0;
const seen = new Set<string>();
const t = (c: unknown, m: string) => {
  if (!c) { if (!seen.has(m)) { console.log('FAIL:', m); seen.add(m); } bad++; }
};

let totalHits = 0, totalBlocks = 0, mults = 0, bonusRuns = 0, empties = 0;

for (let i = 0; i < N; i++) {
  const isBonus = i % 5 === 0;                       // кожен п'ятий забіг — бонусний
  const seed = seedAt(i);
  const setup = buildSetup(seed, isBonus ? 'bonus-buy' : 'bet');
  if (isBonus) bonusRuns++;

  t(setup.spins.length > 0, 'рулетка не крутилась жодного разу');
  if (!isBonus) {
    // у звичайній ставці перша ж кірка зупиняє прокрути
    const firstPick = setup.spins.findIndex((s) => s !== null);
    t(firstPick === -1 || firstPick === setup.spins.length - 1,
      'прокрути не зупинились на першій кірці');
    t(setup.tiers.length <= 1, 'у звичайній ставці більше однієї кірки');
  } else {
    t(setup.spins.length === CONFIG.bonus.spins, 'у бонусці не 15 прокрутів');
    t(setup.tiers.length >= CONFIG.bonus.guarantee, 'гарантія кірок у бонусці не спрацювала');
  }
  t(setup.tiers.length === setup.startCols.length, 'колонок не стільки, скільки кірок');
  for (const c of setup.startCols) t(c >= 0 && c < CONFIG.cols, 'стартова колонка поза шахтою');

  const made = createRun(seed, setup);
  if (!made) { empties++; continue; }
  const { mine, run } = made;

  t(run.picks.length === setup.tiers.length, 'кірок у забігу не стільки, скільки замовили');

  let steps = 0, lastDepth = 0;
  let lastLevels = run.picks.map((p) => p.level);

  while (!run.over && steps++ < 100000) {
    run.tick();

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
          t(cell && !isWall(cell), 'тріщина на порожній клітинці');
          t(cell && !isWall(cell) && cell.dmg === e.stage, 'накопичений урон не збігається з подією');
        }
        t(e.stage < e.of, 'блок мав розколотись, а лишився');
        t(e.of === BLOCKS[e.id].tough, 'невірна міцність у події');
        // земля, камінь, динаміт і множники падають з першого удару — тріщин у них не буває
        t(BLOCKS[e.id].tough > 1, 'блок ' + e.id + ' тріснув, хоча має падати з одного удару');
      }

      if (e.t === 'mult') {
        mults++;
        t(CONFIG.bonus.multTable.some((x) => x.m === e.m), 'невідомий множник x' + e.m);
        // множить УЖЕ накопичене, тому рахунок стрибає рівно в m разів
        t(Math.abs(e.total - e.before * e.m) < 1e-6,
          'множник спрацював не на накопичений виграш: ' + e.before + ' x' + e.m + ' -> ' + e.total);
      }
      if (e.t === 'magic') t(run.picks.some((q) => q.enchanted), 'верстак не зачарував жодної кірки');
      if (e.t === 'tnt') for (const h of e.hit) t(BLOCKS[h.id].kind === 'solid', 'вибух зачепив не той блок');
    }
    lastLevels = run.picks.map((p) => p.level);
    run.events.length = 0;
  }

  t(run.over, 'забіг не завершився за 100000 кроків');
  t(run.reason !== null, 'немає причини завершення');
  t(run.reason !== 'broken' || run.picks.every((p) => p.hp <= 0), 'reason=broken, але не всі кірки зламані');
  // TNT розносить до 8 сусідів за один удар, тому blocks може перегнати hits саме на стільки
  t(run.blocks <= run.hits + run.tnts * 8, 'розколото більше блоків, ніж дозволяють удари + вибухи');
  t(mine.rows.size < 8000, 'сітка розрослась: ' + mine.rows.size);

  totalHits += run.hits; totalBlocks += run.blocks;
}

const played = N - empties;
console.log('раундів:', N, '(бонусних:', bonusRuns + ', без кірки:', empties + ')');
console.log('ударів на забіг:', (totalHits / Math.max(1, played)).toFixed(1),
            '| розколото блоків:', (totalBlocks / Math.max(1, played)).toFixed(1),
            '| множників спіймано:', mults);
console.log(bad === 0 ? 'ALL INVARIANTS OK' : bad + ' failures');
process.exit(bad ? 1 : 0);
