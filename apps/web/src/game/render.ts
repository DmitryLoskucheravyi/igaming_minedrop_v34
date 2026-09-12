/* ============================================================
   RENDER — усе малювання. Скін є -> drawImage, немає -> заглушка.
   Стиль — 2D піксель: різкі краї, фаска як у Minecraft/Terraria.
   ============================================================ */

import { BLOCKS, type Cell, type Tier } from '@minedrop/engine';
import { Assets } from './assets';

type Ctx = CanvasRenderingContext2D;

/* Елемент рулетки: кірка або «пусто» */
export type ReelItem = Tier | null;

/* Кірка у вікні рулетки: наскільки заповнює вписаний квадрат і під
   яким кутом лежить.

   На спрайті кірка намальована по діагоналі — держак іде з
   лівого-нижнього кута в правий-верхній, тобто її власна вісь уже
   під 45°. Було -0.5 рад: разом із власними 45° це ставило її майже
   сторч. -0.28 лишає помітний, але спокійний нахил, а не «стійку».
   Розмір зменшено з 0.74 до 0.66 — щоб кірка не впиралась у край
   круглого вирізу. */
const REEL_PICK_ROT = -0.28;
const REEL_PICK_FILL = 0.66;

export const Render = {
  pixelate(ctx: Ctx) {
    ctx.imageSmoothingEnabled = false;
  },

  /* Панель з фаскою: світло згори-зліва, тінь знизу-справа. */
  panel(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, b = 4) {
    ctx.fillStyle = '#0d0f13';
    ctx.fillRect(x - b, y - b, w + b * 2, h + b * 2);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.fillRect(x, y, w, b);
    ctx.fillRect(x, y, b, h);
    ctx.fillStyle = 'rgba(0,0,0,.38)';
    ctx.fillRect(x, y + h - b, w, b);
    ctx.fillRect(x + w - b, y, b, h);
  },

  /* Фаска навиворіт — виглядає як заглиблення */
  inset(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, b = 4) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(x, y, w, b);
    ctx.fillRect(x, y, b, h);
    ctx.fillStyle = 'rgba(255,255,255,.10)';
    ctx.fillRect(x, y + h - b, w, b);
    ctx.fillRect(x + w - b, y, b, h);
  },

  /* Дерев'яна рама в стилі Terraria: дошки + цвяхи */
  wood(ctx: Ctx, x: number, y: number, w: number, h: number) {
    ctx.fillStyle = '#6b4a2a';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    for (let i = 14; i < h; i += 15) ctx.fillRect(x, y + i, w, 2);
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    for (let i = 16; i < h; i += 15) ctx.fillRect(x, y + i, w, 1);
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.fillRect(x, y, w, 4);
    ctx.fillRect(x, y, 4, h);
    ctx.fillStyle = 'rgba(0,0,0,.42)';
    ctx.fillRect(x, y + h - 4, w, 4);
    ctx.fillRect(x + w - 4, y, 4, h);
    // цвяхи по кутах
    ctx.fillStyle = '#c9a227';
    const n = 6;
    const nails: [number, number][] = [
      [x + 7, y + 7], [x + w - 7 - n, y + 7],
      [x + 7, y + h - 7 - n], [x + w - 7 - n, y + h - 7 - n],
    ];
    for (const [px, py] of nails) ctx.fillRect(px, py, n, n);
  },

  /* Сердечко в підписі HP. Картинка (ui/heart.png) замість колишнього
     масиву пікселів; s — ШИРИНА, висота йде за пропорціями файлу, щоб
     серце не сплющувалось. Немає картинки — лишається намальоване
     сердечко, щоб підпис HP не поїхав. */
  heart(ctx: Ctx, x: number, y: number, s: number) {
    const img = Assets.get('heart');
    if (img) {
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      const h = nw ? s * (nh / nw) : s;
      ctx.drawImage(img, x - s / 2, y - h / 2, s, h);
      return;
    }
    const P = [
      [0, 1, 1, 0, 1, 1, 0],
      [1, 1, 1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1, 1, 1],
      [0, 1, 1, 1, 1, 1, 0],
      [0, 0, 1, 1, 1, 0, 0],
      [0, 0, 0, 1, 0, 0, 0],
    ];
    const u = s / 7;
    const x0 = x - (7 * u) / 2;
    const y0 = y - (6 * u) / 2;
    ctx.fillStyle = '#d64b3f';
    for (let r = 0; r < P.length; r++)
      for (let c = 0; c < P[r].length; c++)
        if (P[r][c]) ctx.fillRect(x0 + c * u, y0 + r * u, u + 0.5, u + 0.5);
  },

  /* Блок-множник. Кожен ікс — своя картинка (blocks/mult-<m>.png): у
     них різні матеріали й кольори, тож рідкість видно з самого блоку
     ще до того, як гравець прочитає цифру. Ікс намальований усередині
     картинки, тому підпису кодом поверх неї немає.

     Запасний варіант лишається навмисно. Множники живуть у таблиці
     конфіга (CONFIG.mult.table), і додати туди новий ікс — це один
     рядок; вимагати, щоб разом із ним хтось не забув намалювати
     картинку, означало б, що забудуть і отримають діру в шахті. */
  multBlock(ctx: Ctx, x: number, y: number, s: number, m: number) {
    const img = Assets.get('block.mult.' + m);
    if (img) {
      ctx.drawImage(img, x, y, s + 1, s + 1);   // +1 щоб не було щілин між блоками
      return;
    }
    this.panel(ctx, x + 2, y + 2, s - 3, s - 3, '#b8860b', 4);
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(x + 2, y + 2, s - 3, (s - 3) * 0.34);
    this.text(ctx, 'X' + m, x + s / 2, y + s * 0.63,
      '800 ' + Math.round(s * (m >= 25 ? 0.32 : 0.42)) + 'px ui-monospace, monospace', '#fff8dc');
  },

  /* Огорожа поля. Не клітинка сітки: межа шахти існує у фізиці сама
     (Mine.get за краєм повертає WALL), а це лише робить її видимою —
     щоб поле не обривалось у порожнечу, коли камера їде за кіркою. */
  fence(ctx: Ctx, x: number, y: number, s: number) {
    const img = Assets.get('fence');
    if (img) { ctx.drawImage(img, x, y, s + 1, s + 1); return; }
    ctx.fillStyle = '#3a4048';
    ctx.fillRect(x, y, s + 1, s + 1);
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    ctx.fillRect(x, y, s, 3);
  },

  /* Другий скін каменю — з глибиною булижник витісняє звичайний.
     Це чиста косметика: клітинка лишається тим самим `stone` (цінність
     0, міцність 1), міняється тільки картинка. Тому вибір робиться
     тут, а не в рушії: у сітці нового блоку не з'явилось, і на
     математику це не впливає ніяк.

     Вибір детермінований від cell.seed — інакше блок миготів би між
     двома скінами щокадру. */
  stoneSkin(row: number, seed: number): string {
    // 0 до 4-го ряду, далі росте і з 12-го булижник переважає
    const p = 0.85 * Math.max(0, Math.min(1, (row - 4) / 8));
    if (p <= 0) return 'block.stone';
    // дешевий хеш сида в [0,1): сид уже розріджений, вистачає перемішування
    const h = (Math.imul(seed | 0, 2246822519) >>> 8) / 0x1000000;
    return h < p ? 'block.stone2' : 'block.stone';
  },

  /* Блок-стрілка: кірка більшає. Картинка є (BLOCKS.grow.skin),
     намальована стрілка нижче — запасний варіант, якщо файл не доїхав. */
  growBlock(ctx: Ctx, x: number, y: number, s: number) {
    const img = Assets.get('block.grow');
    if (img) { ctx.drawImage(img, x, y, s + 1, s + 1); return; }
    this.panel(ctx, x + 2, y + 2, s - 3, s - 3, '#1f8f6d', 4);
    const cx = x + s / 2, u = s / 16;
    ctx.fillStyle = '#eafff6';
    // держак
    ctx.fillRect(cx - u * 1.6, y + s * 0.42, u * 3.2, s * 0.34);
    // наконечник
    ctx.beginPath();
    ctx.moveTo(cx, y + s * 0.2);
    ctx.lineTo(cx + u * 4.4, y + s * 0.5);
    ctx.lineTo(cx - u * 4.4, y + s * 0.5);
    ctx.closePath();
    ctx.fill();
  },

  /* Гумовий блок — трамплін: посилений відскок і швидке падіння.
     Картинка є (BLOCKS.rubber.skin), намальована «пружина» нижче —
     запасний варіант на випадок, якщо файл не доїхав. */
  rubberBlock(ctx: Ctx, x: number, y: number, s: number) {
    const img = Assets.get('block.rubber');
    if (img) { ctx.drawImage(img, x, y, s + 1, s + 1); return; }
    this.panel(ctx, x + 2, y + 2, s - 3, s - 3, '#a3306f', 4);
    // «пружина»: три дуги, щоб зчитувалось як щось пружне
    ctx.strokeStyle = '#ffc2e4';
    ctx.lineWidth = Math.max(2, s * 0.07);
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const yy = y + s * (0.34 + i * 0.16);
      ctx.beginPath();
      ctx.moveTo(x + s * 0.26, yy);
      ctx.quadraticCurveTo(x + s / 2, yy - s * 0.16, x + s * 0.74, yy);
      ctx.stroke();
    }
  },

  /* Скаттер: три за забіг -> безкоштовна бонуска. Картинка є
     (BLOCKS.scatter.skin), намальована зірка нижче — запасний варіант.

     Він навмисно не схожий на решту блоків: гравець мусить упізнати
     його з першого погляду серед руди, бо саме за ним і полює. */
  scatterBlock(ctx: Ctx, x: number, y: number, s: number) {
    const img = Assets.get('block.scatter');
    if (img) { ctx.drawImage(img, x, y, s + 1, s + 1); return; }
    this.panel(ctx, x + 2, y + 2, s - 3, s - 3, '#c2560c', 4);
    const cx = x + s / 2, cy = y + s / 2;
    const R = s * 0.34, r = R * 0.44;
    ctx.fillStyle = '#ffd98a';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rad = i % 2 === 0 ? R : r;
      const px = cx + Math.cos(a) * rad;
      const py = cy + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  },

  /* Руда, яка малюється НАКЛАДКОЮ на булижник, а не власною картинкою:
     художник дав саме накладки (чорний малюнок руди на прозорому), а
     не готові блоки. Тому база в BLOCKS[*].skin у них — той самий
     cobble, а різницю дає ця мапа. */
  ORE_OVERLAY: {
    iron: 'ore.iron', gold: 'ore.gold', redstone: 'ore.redstone',
  } as Partial<Record<Cell['id'], string>>,

  /* Блок. cell = { id, dmg, seed, m }, row — номер ряду (для скінів,
     що залежать від глибини) */
  block(ctx: Ctx, x: number, y: number, s: number, cell: Cell, row = 0) {
    const def = BLOCKS[cell.id];
    if (def.kind === 'mult') { this.multBlock(ctx, x, y, s, cell.m || 2); return; }
    if (def.kind === 'grow') { this.growBlock(ctx, x, y, s); return; }
    if (def.kind === 'rubber') { this.rubberBlock(ctx, x, y, s); return; }
    if (def.kind === 'scatter') { this.scatterBlock(ctx, x, y, s); return; }
    const key = cell.id === 'stone' ? this.stoneSkin(row, cell.seed) : 'block.' + cell.id;
    const img = Assets.get(key);
    if (img) {
      ctx.drawImage(img, x, y, s + 1, s + 1);   // +1 щоб не було щілин між блоками
    } else {
      ctx.fillStyle = def.color;
      ctx.fillRect(x, y, s + 1, s + 1);
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fillRect(x, y, s, 3);
    }
    const ore = this.ORE_OVERLAY[cell.id];
    if (ore) {
      const oi = Assets.get(ore);
      if (oi) ctx.drawImage(oi, x, y, s + 1, s + 1);
    }
    if (cell.dmg > 0) this.cracks(ctx, x, y, s, cell.dmg / def.tough);
  },

  /* Тріщини — чотири намальовані стадії (fx/crack-1..4.png), чорний
     малюнок на прозорому, поверх скіну блоку.

     Раніше вибиті пікселі малювались кодом від cell.seed. Малюнок
     тепер один на всі блоки однієї стадії — і це нормально: стадій
     чотири, вони наростають, і саме наростання читається краще за
     випадковий шум, який раніше на око майже не відрізнявся між
     сусідніми ударами.

     p — частка знятої міцності (cell.dmg / def.tough). Стадія
     ceil(p * 4): будь-який ненульовий урон уже дає першу тріщину, а
     повна міцність — четверту. */
  cracks(ctx: Ctx, x: number, y: number, s: number, p: number) {
    if (p <= 0) return;
    const stage = Math.max(1, Math.min(4, Math.ceil(Math.min(1, p) * 4)));
    const img = Assets.get('crack' + stage);
    if (!img) return;
    ctx.save();
    // не в нуль: тріщина має лежати НА блоці, а не замінювати його
    ctx.globalAlpha = 0.85;
    ctx.drawImage(img, x, y, s + 1, s + 1);
    ctx.restore();
  },

  /* Затемнення клітинок, далеких від кірки. Зона навколо неї лишається
     з тим самим освітленням, що й раніше, а все, що далі за DIM_NEAR
     клітинок, гасне до DIM_MAX. Перехід плавний — різка межа читалась би
     як кругла пляма-ліхтарик, а не як «сюди не дістає світло». */
  dim(ctx: Ctx, x: number, y: number, s: number, a: number) {
    if (a <= 0.004) return;
    ctx.fillStyle = 'rgba(0,0,8,' + a.toFixed(3) + ')';
    ctx.fillRect(x, y, s + 1, s + 1);
  },

  /* Затемнення з глибиною — відчуття, що лізеш углиб */
  shade(ctx: Ctx, x: number, y: number, s: number, row: number) {
    const a = Math.min(0.5, row * 0.008);
    if (a <= 0.01) return;
    ctx.fillStyle = 'rgba(0,0,10,' + a.toFixed(3) + ')';
    ctx.fillRect(x, y, s + 1, s + 1);
  },

  /* Кірка. x,y — центр у пікселях, rot — радіани.

     size — ВИДИМИЙ розмір малюнка, а не розмір полотна. Полотно
     більше рівно настільки, наскільки в скіні є прозорі поля:
     draw = size / Assets.pickFill(tier). Без цього переходу нові
     скіни (малюнок впритул до країв, fill 1.00) вийшли б на 23%
     більшими за старі (fill 0.8125) при тому самому size — а разом із
     ними розійшлись би картинка й радіус зіткнення у фізиці. */
  pickaxe(ctx: Ctx, x: number, y: number, size: number, tier: Tier, rot: number) {
    const img = Assets.pick(tier);
    const draw = size / Assets.pickFill(tier);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot || 0);

    if (img) {
      ctx.drawImage(img, -draw / 2, -draw / 2, draw, draw);
      ctx.restore();
      return;
    }

    // заглушка, якщо картинки нема
    const u = size / 32;
    ctx.fillStyle = '#6b4a2a';
    ctx.fillRect(-2 * u, -6 * u, 4 * u, 20 * u);
    ctx.fillStyle = tier.color;
    ctx.beginPath();
    ctx.moveTo(-13 * u, -8 * u);
    ctx.quadraticCurveTo(0, -15 * u, 13 * u, -8 * u);
    ctx.lineTo(9 * u, -3 * u);
    ctx.quadraticCurveTo(0, -9 * u, -9 * u, -3 * u);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  },

  /* «Пусто» на стрічці — намальований червоний хрест
     (ui/reel-nothing.png). Пропорції беремо з файлу: він не квадратний
     (488x482), і вписувати його в квадрат означало б трохи сплющити.
     Немає картинки — лишається старий процедурний Х. */
  cross(ctx: Ctx, x: number, y: number, size: number, alpha = 1) {
    const img = Assets.get('reelNothing');
    if (img) {
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      const w = size, h = nw ? size * (nh / nw) : size;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
      ctx.restore();
      return;
    }
    const t = Math.max(4, size * 0.16);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#0d0f13';
    ctx.fillRect(-size / 2 - 2, -t / 2 - 2, size + 4, t + 4);
    ctx.fillRect(-t / 2 - 2, -size / 2 - 2, t + 4, size + 4);
    ctx.fillStyle = '#c2413a';
    ctx.fillRect(-size / 2, -t / 2, size, t);
    ctx.fillRect(-t / 2, -size / 2, t, size);
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.fillRect(-size / 2, -t / 2, size, Math.max(2, t * 0.25));
    ctx.fillRect(-t / 2, -size / 2, Math.max(2, t * 0.25), size);
    ctx.restore();
  },

  /* Символ стрічки — САМ СКІН, і більше нічого.

     БЕЗ власної підкладки: раніше тут був inset() — квадрат кольору
     тіру з фаскою. Під прямокутною рамкою він читався як комірка
     автомата, але всередині круглого вирізу квадрат у колі виглядає
     чужорідно. Тепер кірка лежить просто на фоні слота, а роль вікна
     виконує саме кільце.

     БЕЗ ПІДПИСУ НАЗВОЮ. Раніше під кіркою стояло «STONE», «IRON» і
     т. д. Скіни тірів і так відрізняються між собою з першого погляду,
     а підпис у круглому вікні тіснив сам символ і змушував малювати
     його дрібнішим, ніж треба. Тому назви немає, а символ малюється у
     повний розмір вікна — той самий, що й у «пусто».

     Підсвітка виграшної комірки лишається, але кружком, а не заливкою
     прямокутника — інакше квадрат повернувся б у момент зупинки. */
  reelItem(ctx: Ctx, x: number, y: number, w: number, h: number, item: ReelItem, hot: boolean) {
    if (hot) {
      // радіус від безпечного квадрата, а не від усієї комірки: інакше
      // підсвітка залила б увесь круглий виріз
      const cx0 = x + w / 2, cy0 = y + h / 2, r = Math.min(w, h) * 0.7 * 0.58;
      const g = ctx.createRadialGradient(cx0, cy0, r * 0.2, cx0, cy0, r);
      g.addColorStop(0, 'rgba(255,211,77,.22)');
      g.addColorStop(1, 'rgba(255,211,77,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx0, cy0, r, 0, Math.PI * 2);
      ctx.fill();
    }

    /* Верстка йде не по всій комірці, а по ВПИСАНОМУ в неї квадрату
       (0.7 — сторона квадрата у колі того ж діаметра): комірка
       завбільшки з круглий виріз, і кути в неї не влазять. */
    const cx = x + w / 2;
    const cy = y + h / 2;
    const box = Math.min(w, h) * 0.7;

    if (!item) this.cross(ctx, cx, cy, box * 0.74 * 0.58, 0.95);
    else this.pickaxe(ctx, cx, cy, box * REEL_PICK_FILL, item, REEL_PICK_ROT);
  },

  /* HP над кіркою: сердечко + «40/100» */
  hpLabel(ctx: Ctx, x: number, y: number, hp: number, hpMax: number, scale: number) {
    const s = Math.max(11, scale * 0.17);
    const txt = Math.max(0, Math.round(hp)) + '/' + hpMax;
    const font = '700 ' + Math.round(s) + 'px ui-monospace, monospace';
    ctx.font = font;
    const tw = ctx.measureText(txt).width;
    const hs = s * 1.15;
    const total = hs + s * 0.35 + tw;

    this.heart(ctx, x - total / 2 + hs / 2, y, hs);
    const p = hp / hpMax;
    this.text(ctx, txt, x - total / 2 + hs + s * 0.35, y + s * 0.36, font,
      p > 0.5 ? '#dfe8f0' : p > 0.22 ? '#ffd34d' : '#ff7a6e', 'left');
  },

  /* ---- РАСТРОВИЙ ШРИФТ ЦИФР (ui/popup-font.png) ----

     Жовті цифри з коричневою обводкою — той самий стиль, що й решта
     нового арту, замість системного ui-monospace у попапах виграшу.

     Прямокутники гліфів ЗАМІРЯНО з файлу (пошук зв'язних плям по
     альфа-каналу), а не поділом на рівну сітку: сітка в листі рівна
     лише приблизно — '8' стоїть на 3 px вище за сусідів свого ряду, а
     '°' узагалі втиснуте в кут. Порядок у листі теж не абетковий
     (0 1 2 3 ° / 4 6 X 9 / 5 7 8 /), тому мапа явна.

     Усі цифри — 18 px заввишки, це й є смуга рядка (FONT_BAND):
     вирівнюємо по НИЗУ смуги, тобто y — базова лінія, як у text(). */
  FONT_BAND: 18,
  FONT_GAP: 2,                    // проміжок між гліфами, у px файлу
  FONT_FILL: '#ffe429',           // обидва кольори взято з самого листа
  FONT_OUTLINE: '#782f00',
  FONT_GLYPHS: {
    '0': { x: 1, y: 1, w: 11, h: 18, dy: 0 },
    '1': { x: 15, y: 1, w: 7, h: 18, dy: 0 },
    '2': { x: 25, y: 1, w: 11, h: 18, dy: 0 },
    '3': { x: 39, y: 1, w: 11, h: 18, dy: 0 },
    '4': { x: 1, y: 22, w: 11, h: 18, dy: 0 },
    '5': { x: 1, y: 43, w: 11, h: 18, dy: 0 },
    '6': { x: 15, y: 22, w: 11, h: 18, dy: 0 },
    '7': { x: 15, y: 43, w: 11, h: 18, dy: 0 },
    '8': { x: 29, y: 40, w: 11, h: 18, dy: 0 },
    '9': { x: 44, y: 22, w: 11, h: 18, dy: 0 },
    '/': { x: 44, y: 43, w: 9, h: 18, dy: 0 },
    // «ікс» множника; у листі він на 3 px нижчий за цифри — ставимо по центру
    'x': { x: 29, y: 22, w: 12, h: 15, dy: 2 },
    'X': { x: 29, y: 22, w: 12, h: 15, dy: 2 },
    // градус — крихітний, тримається верху смуги
    '°': { x: 53, y: 1, w: 5, h: 6, dy: 0 },
  } as Record<string, { x: number; y: number; w: number; h: number; dy: number }>,

  /* Гліфів, яких у листі НЕМАЄ, але без яких не обійтись: кома/крапка
     в сумі та '+' перед нею. Домальовуємо їх тими самими двома
     кольорами — це чесніше, ніж рвати один рядок між двома шрифтами.
     Числа — ширини в px смуги. */
  FONT_DRAWN: { '.': 4, ',': 4, '+': 11, '-': 9, ' ': 6 } as Record<string, number>,

  /** Ширина рядка растровим шрифтом при висоті цифри h. -1 — не всі
      символи підтримані, викликач має взяти системний шрифт. */
  pixelWidth(s: string, h: number): number {
    if (!s.length) return 0;
    if (!Assets.get('popupFont')) return -1;
    const k = h / this.FONT_BAND;
    let w = 0;
    for (const ch of s) {
      const g = this.FONT_GLYPHS[ch];
      if (g) { w += (g.w + this.FONT_GAP) * k; continue; }
      const d = this.FONT_DRAWN[ch];
      if (d == null) return -1;
      w += (d + this.FONT_GAP) * k;
    }
    return w - this.FONT_GAP * k;   // хвостовий проміжок не рахуємо
  },

  /* Малює рядок растровим шрифтом. y — базова лінія (низ цифри),
     h — висота цифри в пікселях екрана. Повертає ширину або -1, якщо
     шрифт не годиться для цього рядка (нічого не намальовано). */
  pixelText(ctx: Ctx, s: string, x: number, y: number, h: number, align: CanvasTextAlign = 'center'): number {
    const total = this.pixelWidth(s, h);
    if (total < 0) return -1;
    const img = Assets.get('popupFont');
    if (!img) return -1;

    const k = h / this.FONT_BAND;
    let px = x;
    if (align === 'center') px = x - total / 2;
    else if (align === 'right' || align === 'end') px = x - total;
    const top = y - h;

    for (const ch of s) {
      const g = this.FONT_GLYPHS[ch];
      if (g) {
        ctx.drawImage(img, g.x, g.y, g.w, g.h, px, top + g.dy * k, g.w * k, g.h * k);
        px += (g.w + this.FONT_GAP) * k;
        continue;
      }
      const d = this.FONT_DRAWN[ch];
      if (d == null) continue;      // pixelWidth уже гарантував, що сюди не зайдемо
      this.pixelDrawn(ctx, ch, px, top, k);
      px += (d + this.FONT_GAP) * k;
    }
    return total;
  },

  /* Домальовані гліфи ('.', ',', '+', '-'). Спершу темний прямокутник
     на піксель більший з кожного боку — це та сама обводка, що є в
     самому листі, — потім жовта заливка. */
  pixelDrawn(ctx: Ctx, ch: string, px: number, top: number, k: number) {
    const bar = (bx: number, by: number, bw: number, bh: number) => {
      ctx.fillStyle = this.FONT_OUTLINE;
      ctx.fillRect(px + (bx - 1) * k, top + (by - 1) * k, (bw + 2) * k, (bh + 2) * k);
      ctx.fillStyle = this.FONT_FILL;
      ctx.fillRect(px + bx * k, top + by * k, bw * k, bh * k);
    };
    if (ch === '.') bar(1, 14, 4, 4);
    else if (ch === ',') { bar(1, 14, 4, 4); bar(1, 18, 3, 3); }
    else if (ch === '+') { bar(1, 7, 9, 4); bar(3, 4, 4, 10); }
    else if (ch === '-') bar(1, 8, 7, 4);
  },

  text(ctx: Ctx, s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'center') {
    ctx.font = font;
    ctx.textAlign = align;
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,.8)';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  },

  /* Сума + іконка валюти після неї. cur — код валюти ('RUB'|'USDT'|'XTR'),
     значок береться з Assets (мапа 'cur.<код>'); для рубля (mono) значок
     тонується в колір тексту, кольорові монети малюються як є. */
  money(
    ctx: Ctx, s: string, x: number, y: number, font: string, color: string,
    cur: string, mono: boolean, align: CanvasTextAlign = 'center',
  ) {
    const px = parseInt(/(\d+)px/.exec(font)?.[1] ?? '14', 10);
    ctx.font = font;
    const tw = ctx.measureText(s).width;

    const key = 'cur.' + cur;
    const img = (mono ? Assets.tint(key, color) : Assets.get(key)) as
      | HTMLImageElement | HTMLCanvasElement | null;
    const nat = img
      ? { w: img instanceof HTMLImageElement ? img.naturalWidth : img.width,
          h: img instanceof HTMLImageElement ? img.naturalHeight : img.height }
      : null;
    const ih = Math.round(px * 1.4);
    const iw = nat && nat.h ? ih * (nat.w / nat.h) : 0;
    const gap = img ? px * 0.2 : 0;
    const total = tw + gap + iw;

    let left = x;
    if (align === 'center') left = x - total / 2;
    else if (align === 'right' || align === 'end') left = x - total;

    this.text(ctx, s, left, y, font, color, 'left');
    // значок трохи «сідає» на базову лінію тексту, вирівнюємо по центру великих літер
    if (img && iw) ctx.drawImage(img, left + tw + gap, y - ih * 0.82, iw, ih);
  },

  /* Значок валюти для растрового рядка: сама картинка й розміри, які
     вона займе при висоті цифри h. Окремо від малювання, бо викликачу
     часто треба ЗАМІРЯТИ рядок разом зі значком, перш ніж вирішити,
     де його ставити (див. панель результату в hud-canvas). */
  pixelCurIcon(h: number, cur: string, mono: boolean, color: string) {
    const key = 'cur.' + cur;
    const img = (mono ? Assets.tint(key, color) : Assets.get(key)) as
      | HTMLImageElement | HTMLCanvasElement | null;
    if (!img) return { img: null, w: 0, h: 0, gap: 0 };
    const nw = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
    const nh = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
    const ih = h * 1.15;
    return { img, w: nh ? ih * (nw / nh) : 0, h: ih, gap: h * 0.18 };
  },

  /** Ширина «сума + значок валюти» растровим шрифтом. -1 — не набирається. */
  pixelMoneyWidth(s: string, h: number, cur: string, mono: boolean, color: string): number {
    const tw = this.pixelWidth(s, h);
    if (tw < 0) return -1;
    const ic = this.pixelCurIcon(h, cur, mono, color);
    return tw + ic.gap + ic.w;
  },

  /* Те саме, що money(), але растровим шрифтом (див. pixelText).
     Повертає намальовану ширину або -1, якщо рядок цим шрифтом не
     набирається — тоді викликач малює звичайним money().

     Значок валюти лишається картинкою й тонується як завжди: він і
     раніше був окремим спрайтом, а не символом шрифту. */
  pixelMoney(
    ctx: Ctx, s: string, x: number, y: number, h: number, color: string,
    cur: string, mono: boolean, align: CanvasTextAlign = 'center',
  ): number {
    const tw = this.pixelWidth(s, h);
    if (tw < 0) return -1;

    const ic = this.pixelCurIcon(h, cur, mono, color);
    const total = tw + ic.gap + ic.w;
    let left = x;
    if (align === 'center') left = x - total / 2;
    else if (align === 'right' || align === 'end') left = x - total;

    this.pixelText(ctx, s, left, y, h, 'left');
    if (ic.img && ic.w) ctx.drawImage(ic.img, left + tw + ic.gap, y - ic.h * 0.92, ic.w, ic.h);
    return total;
  },
};
