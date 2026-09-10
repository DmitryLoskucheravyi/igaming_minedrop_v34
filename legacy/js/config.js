/* ============================================================
   CONFIG — усі цифри гри в одному місці.
   Працює і в браузері, і в node (sim/*.js)

   ВАЖЛИВО: фізика рахується в КЛІТИНКАХ, не в пікселях
   (1 одиниця = 1 блок). Тому гра однаково поводиться
   на будь-якому розмірі екрана.
   ============================================================ */

const CONFIG = {
  cols: 8,                // ширина шахти в блоках
  maxCell: 130,           // стеля розміру блоку (px). Постав 9999 — поле завжди на всю ширину
  minCell: 54,

  startBalance: 3000,      // dev
  bets: [10, 25, 50, 100, 250],
  payoutK: 610,           // дільник виплати. Підбирається sim/final.js (з bootstrap CI)
  maxWinX: 5000,          // стеля виграшу за раунд, у ставках. Без неї ланцюг
                          // множників у бонусці розганяється в нескінченність

  /* ---- рулетка ----
     7 прокрутів = 7 ШАНСІВ на кірку. Перша ж кірка зупиняє прокрути
     і починається гра. Не випало за 7 — ставка згоріла.        */
  spinsPerBet: 7,
  nothingWeight: 84,      // вага «пусто». Кірки разом важать 16 -> ~16% за прокрут
  reel: {
    spinMs: 620,          // тривалість одного прокруту — швидко
    gapMs: 170,           // пауза між прокрутами
    stripLen: 22,
    targetIndex: 17,
    visible: 5,           // скільки комірок видно у вікні рулетки
    widthRatio: 3,        // комірка втричі ширша за висоту
    riseMs: 550           // за скільки рулетка їде вгору, коли випала кірка
  },

  manualAim: false,       // true — гравець сам клікає колонку, куди кинути кірку

  /* ---- БОНУСНА ГРА ----
     Вмикається, коли кірка випала streak ставок ПІДРЯД,
     або купується за buyCost ставок.
     Рулетка сама крутить spins разів, і скільки кірок випало —
     стільки й падає в шахту ОДНОЧАСНО. У бонусній шахті є блоки
     з множниками: вони множать НАКОПИЧЕНИЙ на той момент виграш. */
  bonus: {
    spins: 15,
    guarantee: 1,         // мінімум стільки кірок (інакше останній прокрут форситься)
    spinMs: 260,          // прокрути в бонусці швидші
    gapMs: 55,
    buyCost: 70,          // ціна купівлі бонуски, у ставках
    /* Скільки ставок ПІДРЯД з кіркою вмикає бонуску.
       УВАГА: 3 підряд тут неможливо. Кірка випадає в ~70% ставок, тому
       стрік-3 спрацьовував би раз на 6 ставок, а бонуска ціною x70 давала б
       RTP понад 1000%. 12 -> раз на ~180 ставок, і все сходиться в 95%.
       Хочеш 3 — тоді треба або впасти ціну бонуски до ~x6 (buyCost: 6),
       або опустити шанс кірки до ~2.7% за прокрут (nothingWeight: 580). */
    streak: 12,
    reelNothing: 14,      // у бонусці «пусто» важить менше -> кірки сиплються часто
    tierBoost: 1.75,      // ...і зміщені до вищих рівнів (вага * boost^рівень)
    multWeight: 0.3,      // вага блоків-множників у БОНУСНІЙ шахті
    multWeightBase: 0.25, // ...і мінімальний шанс на них у звичайній грі
    /* Що більший ікс — то менший шанс.
       x25 і x100 прибрані свідомо: множники перемножуються, тому один
       такий ікс у ланцюгу вистрілював за стелю виграшу, і кеп починав
       нести 8+ п.п. RTP замість того, щоб бути запобіжником.
       Хвіст будує КІЛЬКІСТЬ множників (multWeight), а не їхній розмір:
       при multWeight 1.0 кеп зрізав 85% віддачі бонуски. */
    multTable: [ { m:  2, weight: 58 },
                 { m:  3, weight: 26 },
                 { m:  5, weight: 11 },
                 { m: 10, weight:  4 },
                 { m: 15, weight:  1 } ],
    spread: 0.8           // на скільки клітинок рознести старт кірок по висоті
  },

  /* ---- фізика (в клітинках за секунду) ---- */
  phys: {
    gravity: 33,
    maxFall: 27,
    restitution: 0.34,    // частка швидкості, що лишається після удару
    bounceKick: 2.6,      // додатковий підкид угору при ударі
    sideKick: 2.4,        // бічний імпульс — саме він дає рух по діагоналі
    sideKickRand: 1.6,
    wallBounce: 0.7,      // відскок від бічної стінки шахти
    airDrag: 0.25,        // гальмування по горизонталі (мале, щоб діагональ жила)
    maxSideSpeed: 9,
    spinKick: 11,         // кутова швидкість від удару (rad/s) — перевертання
    spinDamp: 0.55,
    bodyR: 0.36,          // радіус тіла кірки в частках клітинки
    substep: 0.22,        // максимальний крок інтегрування в клітинках
    hitCooldown: 0.05,    // мінімум часу між ударами по одному блоку
    tntBlast: 6.0,        // підкид від вибуху TNT
    startHeight: 3,       // з якої висоти падає кірка
    maxHits: 900          // страховка від нескінченного раунду
  },

  camLead: 0.42,          // де тримати кірку по вертикалі екрана під час гри
  camIdle: 0.80,          // поки крутиться рулетка — поверхня отут (частка висоти екрана)
  camLerp: 6
};

/* ---------- КІРКИ ----------
   hp     — запас міцності кірки (100..400): скільки ударів вона взагалі витримає
   dmg    — УРОН за удар: чим вища кірка, тим швидше довбає руду
            (ударів по блоку = ceil(BLOCKS[*].tough / dmg))
   weight — шанс випасти на прокруті (разом 16 проти nothingWeight = 84)
*/
const TIERS = [
  { id:'copper',  name:'Copper',  weight:6.60, hp:100, dmg:1, color:'#c87f5a', color2:'#8c4f34',
    skin:'../apps/web/public/assets/pickaxes/copper.webp',  skinMagic:'../apps/web/public/assets/pickaxes/coper_magic.webp' },
  { id:'lvl2',    name:'Wooden',  weight:4.30, hp:160, dmg:2, color:'#a9803f', color2:'#6b4a20',
    skin:'../apps/web/public/pickaxes/lvl2.webp',    skinMagic:'../apps/web/public/pickaxes/lvl2-magic.webp' },
  { id:'lvl3',    name:'Stone',   weight:2.70, hp:220, dmg:3, color:'#a8a8a8', color2:'#6e6e6e',
    skin:'../apps/web/public/pickaxes/lvl3.png',     skinMagic:'../apps/web/public/pickaxes/lvl3-magic.webp' },
  { id:'lvl4',    name:'Iron',    weight:1.60, hp:280, dmg:4, color:'#e2e2e2', color2:'#9d9d9d',
    skin:'../apps/web/public/pickaxes/lvl4.png',     skinMagic:'../apps/web/public/pickaxes/lvl4-magic.gif' },
  { id:'gold',    name:'Golden',  weight:0.66, hp:340, dmg:5, color:'#f7d13a', color2:'#c79a10',
    skin:'../apps/web/public/pickaxes/gold.png',     skinMagic:'../apps/web/public/pickaxes/gold-magic.webp' },
  { id:'diamond', name:'Diamond', weight:0.14, hp:400, dmg:7, color:'#57eede', color2:'#22b7a8',
    skin:'../apps/web/public/pickaxes/diamond.png',  skinMagic:'../apps/web/public/pickaxes/diamond-magic.webp' }
];

/* Порожній результат прокруту. Іконка поки просто «Х». */
const NOTHING = { id:'none', name:'Пусто', none:true, color:'#39424f', color2:'#242b35' };

/* ---------- БЛОКИ ----------
   tough — МІЦНІСТЬ блоку. Кірка знімає свій dmg за удар, блок падає
           коли накопичений урон >= tough.
           Земля, камінь, динаміт мають tough 1 — б'ються ЗАВЖДИ з одного
           удару будь-якою кіркою. Міцність є тільки в руди.
   cost  — скільки HP кірки з'їдає ОДИН удар
   value — скільки грошей дає розколотий блок (множиться на ставку)
*/
const BLOCKS = {
  dirt:    { id:'dirt',    name:'Земля',   kind:'solid', tough: 1, cost: 3, value: 2, color:'#8a5f38', skin:'../apps/web/public/blocks/dirt.webp' },
  stone:   { id:'stone',   name:'Камінь',  kind:'solid', tough: 1, cost: 3, value: 4, color:'#8f8f8f', skin:'../apps/web/public/blocks/stone.png'  },
  coal:    { id:'coal',    name:'Вугілля', kind:'solid', tough: 2, cost: 5, value: 8, color:'#5f5f5f', skin:'../apps/web/public/blocks/coal.webp' },
  iron:    { id:'iron',    name:'Залізо',  kind:'solid', tough: 4, cost: 6, value:16, color:'#b98b6c', skin:'../apps/web/public/blocks/iron.png'  },
  gold:    { id:'gold',    name:'Золото',  kind:'solid', tough: 6, cost: 7, value:30, color:'#e8c33a', skin:'../apps/web/public/blocks/gold.png'  },
  diamond: { id:'diamond', name:'Алмаз',   kind:'solid', tough: 9, cost: 8, value:60, color:'#4fe6e0', skin:'../apps/web/public/blocks/diamond.jpg'  },
  tnt:     { id:'tnt',     name:'TNT',     kind:'tnt',   tough: 1, cost:20, value: 0, color:'#d63b1f', skin:'../apps/web/public/blocks/tnt.jpg'  },
  magic:   { id:'magic',   name:'Верстак', kind:'magic', tough: 1, cost: 0, value: 0, color:'#c8a165', skin:'../apps/web/public/blocks/magic.png'  },
  // блок-множник, тільки в бонусній шахті. Множник (x2, x3...) лежить у самій клітинці
  mult:    { id:'mult',    name:'Множник', kind:'mult',  tough: 1, cost: 2, value: 0, color:'#c9a227' }
};

/* ---------- ГЕНЕРАЦІЯ ГЛИБИНИ ----------
   Шахта нескінченна. Вага кожного блоку — функція від номера ряду.
   ramp(r, a, b): 0 до ряду a, 1 після ряду b, лінійно між ними.
*/
function ramp(r, a, b) { return Math.max(0, Math.min(1, (r - a) / (b - a))); }

function depthWeights(r, bonus) {
  return {
    air:     r < 2 ? 0 : 7,
    dirt:    70 * (1 - ramp(r, 0, 6)),
    stone:   30 + 45 * ramp(r, 0, 6),
    coal:    22 * ramp(r, 2, 10),
    iron:    22 * ramp(r, 7, 20),
    gold:    16 * ramp(r, 14, 32),
    diamond: 12 * ramp(r, 22, 50),
    tnt:     r < 3 ? 0 : 2.5,
    magic:   r < 3 ? 0 : 1.4,
    mult:    r < 2 ? 0 : (bonus ? CONFIG.bonus.multWeight : CONFIG.bonus.multWeightBase)
  };
}

/* Таблиця прокруту рулетки: «пусто» + усі кірки */
function reelTable() {
  return [{ item: NOTHING, weight: CONFIG.nothingWeight }]
    .concat(TIERS.map(t => ({ item: t, weight: t.weight })));
}

/* У бонусці своя таблиця: кірки частіші й кращі */
function bonusReelTable() {
  const B = CONFIG.bonus;
  return [{ item: NOTHING, weight: B.reelNothing }]
    .concat(TIERS.map((t, i) => ({ item: t, weight: t.weight * Math.pow(B.tierBoost, i) })));
}

if (typeof module !== 'undefined')
  module.exports = { CONFIG, TIERS, BLOCKS, NOTHING, depthWeights, ramp, reelTable, bonusReelTable };
