/* Інваріанти фізики та логіки. npm run sim:smoke -- [забігів] */
import { BLOCKS, CONFIG, TIERS } from '../src/config';
import { buildSetup, createRun } from '../src/round';
import { MULT_CHAIN_CAP, MULT_WINDOW_SEC, TNT_MAX_HITS } from '../src/run';
import { isWall } from '../src/world';
import { seedAt } from './seeds';

const N = parseInt(process.argv[2] || '3000', 10);
const R = CONFIG.phys.bodyR;

let bad = 0;
const seen = new Set<string>();
const t = (c: unknown, m: string) => {
  if (!c) { if (!seen.has(m)) { console.log('FAIL:', m); seen.add(m); } bad++; }
};

let totalHits = 0, totalBlocks = 0, mults = 0, empties = 0;

for (let i = 0; i < N; i++) {
  const seed = seedAt(i);
  const setup = buildSetup(seed);

  t(setup.spins.length > 0, 'рулетка не крутилась жодного разу');
  // у звичайній ставці перша ж кірка зупиняє прокрути
  const firstPick = setup.spins.findIndex((s) => s !== null);
  t(firstPick === -1 || firstPick === setup.spins.length - 1,
    'прокрути не зупинились на першій кірці');
  t(setup.tiers.length <= 1, 'у ставці більше однієї кірки');
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

    // TNT (навіть від тієї самої кірки, в тому самому дотику — див. collide():
    // удар тепер б'є ВСІ дотичні блоки одразу, і TNT серед них може своїм
    // вибухом заднім числом прибрати клітинку, що щойно тріснула від ІНШОГО
    // дотичного блоку цього ж кроку) могла добити довільну клітинку цього
    // тіку — тому стан клітинки після 'crack' звіряємо лише як TNT не було.
    const tntThisTick = run.events.some((ev) => ev.t === 'tnt');
    for (const e of run.events) {
      if (e.t === 'break' || e.t === 'magic' || e.t === 'tnt' || e.t === 'mult')
        t(mine.get(e.r, e.c) === null, 'блок не прибрався з сітки після ' + e.t);

      if (e.t === 'crack') {
        // при кількох кірках сусідня могла добити цей самий блок у цьому ж кроці,
        // тому стан клітинки перевіряємо лише коли кірка одна й TNT не втручався
        if (run.picks.length === 1 && !tntThisTick) {
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
        t(CONFIG.mult.table.some((x) => x.m === e.m), 'невідомий множник x' + e.m);
        // блок-множник більше не іксує накопичене — він відкриває вікно:
        // active — активний множник вікна (>= номіналу блоку, <= стелі),
        // secs — довжина вікна
        t(e.secs === MULT_WINDOW_SEC, 'вікно множника не ' + MULT_WINDOW_SEC + 'с: ' + e.secs);
        t(e.active >= e.m && e.active <= MULT_CHAIN_CAP,
          'активний множник поза межами: ' + e.active + ' (блок x' + e.m + ')');
        t(run.multActive === e.active && run.multWindowT > 0,
          'стан вікна не збігається з подією');
      }
      // стіл зачарування — ЄДИНЕ джерело магічного скіну; 3 рівні
      if (e.t === 'magic') {
        t(run.picks.some((q) => q.enchanted), 'стіл зачарування не зачарував жодної кірки');
        t(e.lvl >= 1 && e.lvl <= CONFIG.enchant.steps.length, 'рівень зачарування поза межами: ' + e.lvl);
        t(e.mult === CONFIG.enchant.steps[e.lvl - 1], 'множник не відповідає рівню');
      }
      // верстак підвищує тір або лікує, але enchanted НЕ чіпає
      if (e.t === 'upgrade') {
        const q = run.picks[e.pick];
        t(!!q, 'подія верстака посилається на неіснуючу кірку');
        if (q && e.healOnly) t(q.level === TIERS.length - 1, 'healOnly-апгрейд не на топ-тірі');
        if (q && !e.healOnly) t(q.level > 0, 'апгрейд тіру не підняв рівень кірки');
      }
      // 'tnt' у hit — ланцюгова детонація (той TNT теж вибухне окремою подією)
      if (e.t === 'tnt') {
        t(e.chain >= 1, 'chain лічильник TNT некоректний: ' + e.chain);
        for (const h of e.hit) {
          const k = BLOCKS[h.id].kind;
          t(k === 'solid' || k === 'magic' || k === 'upgrade' || k === 'tnt', 'вибух зачепив не той блок');
        }
      }
      if (e.t === 'tntchain') t(e.chain >= 3 && e.mult > 1, 'бонус ланцюга TNT при chain < 3');
    }
    lastLevels = run.picks.map((p) => p.level);
    run.events.length = 0;
  }

  t(run.over, 'забіг не завершився за 100000 кроків');
  t(run.reason !== null, 'немає причини завершення');
  t(run.reason !== 'broken' || run.picks.every((p) => p.hp <= 0), 'reason=broken, але не всі кірки зламані');
  // TNT розносить до TNT_MAX_HITS сусідів за один вибух, тому blocks може перегнати hits саме на стільки
  t(run.blocks <= run.hits + run.tnts * TNT_MAX_HITS, 'розколото більше блоків, ніж дозволяють удари + вибухи');
  t(mine.rows.size < 8000, 'сітка розрослась: ' + mine.rows.size);

  totalHits += run.hits; totalBlocks += run.blocks;
}

const played = N - empties;
console.log('раундів:', N, '(без кірки:', empties + ')');
console.log('ударів на забіг:', (totalHits / Math.max(1, played)).toFixed(1),
            '| розколото блоків:', (totalBlocks / Math.max(1, played)).toFixed(1),
            '| множників спіймано:', mults);
console.log(bad === 0 ? 'ALL INVARIANTS OK' : bad + ' failures');
process.exit(bad ? 1 : 0);
