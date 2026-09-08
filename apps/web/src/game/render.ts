/* ============================================================
   RENDER — усе малювання. Скін є -> drawImage, немає -> заглушка.
   Стиль — 2D піксель: різкі краї, фаска як у Minecraft/Terraria.
   ============================================================ */

import { BLOCKS, type Cell, type Tier } from '@minedrop/engine';
import { Assets } from './assets';

type Ctx = CanvasRenderingContext2D;

/* Елемент рулетки: кірка або «пусто» */
export type ReelItem = Tier | null;

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

  /* Піксельне сердечко */
  heart(ctx: Ctx, x: number, y: number, s: number) {
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
    ctx.fillStyle = '#0d0f13';
    for (let r = 0; r < P.length; r++)
      for (let c = 0; c < P[r].length; c++)
        if (P[r][c]) ctx.fillRect(x0 + c * u - u * 0.35, y0 + r * u - u * 0.35, u * 1.7, u * 1.7);
    ctx.fillStyle = '#d64b3f';
    for (let r = 0; r < P.length; r++)
      for (let c = 0; c < P[r].length; c++)
        if (P[r][c]) ctx.fillRect(x0 + c * u, y0 + r * u, u + 0.5, u + 0.5);
    ctx.fillStyle = '#f08a80';                       // блік
    ctx.fillRect(x0 + u, y0 + u, u, u);
    ctx.fillRect(x0 + u, y0 + 2 * u, u, u);
  },

  /* Блок-множник: пише свій ікс просто на собі */
  multBlock(ctx: Ctx, x: number, y: number, s: number, m: number) {
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

  /* Блок-стрілка: кірка більшає втричі. Малюється кодом — картинки для
     нього поки немає; щойно з'явиться, досить прописати skin у BLOCKS. */
  growBlock(ctx: Ctx, x: number, y: number, s: number) {
    // з'явиться картинка (skin у BLOCKS.grow) — вона й піде в діло
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

  /* Гумовий блок — трамплін: посилений відскок і швидке падіння. */
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

  /* Скаттер: три за забіг -> безкоштовна бонуска. Малюється кодом, доки
     немає картинки (з'явиться — досить прописати skin у BLOCKS).

     Зірка, і навмисно не схожа на решту блоків: гравець мусить упізнати
     її з першого погляду серед руди, бо саме за нею й полює. */
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
    if (cell.dmg > 0) this.cracks(ctx, x, y, s, cell.dmg / def.tough, cell.seed || 0);
  },

  /* Тріщини як у майні: чим більше ударів — тим більше вибитих пікселів.
     Малюнок детермінований від seed, тому тріщини наростають, а не стрибають. */
  cracks(ctx: Ctx, x: number, y: number, s: number, p: number, seed: number) {
    if (p <= 0) return;
    const n = Math.round(Math.min(1, p) * 22);
    /* Math.imul, а не звичайне множення: seed доходить до 2^31, і
       seed * 2654435761 давало ~5.7e18 — далеко за межами точного
       діапазону double (2^53). Молодші біти там уже втрачені, тобто
       «випадковість» малюнка тріщин була вироджена. imul рахує саме
       32-бітний добуток, як і задумано. */
    let st = (Math.abs(Math.imul(seed | 0, 2654435761)) % 2147483647) || 12345;
    const rnd = () => (st = (st * 48271) % 2147483647) / 2147483647;
    const u = s / 16;

    for (let i = 0; i < n; i++) {
      const px = Math.floor(rnd() * 14) * u + u;
      const py = Math.floor(rnd() * 14) * u + u;
      const w = u * (1 + Math.floor(rnd() * 2));
      const h = u * (1 + Math.floor(rnd() * 2));
      ctx.fillStyle = 'rgba(0,0,0,.62)';
      ctx.fillRect(x + px, y + py, w, h);
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.fillRect(x + px, y + py, w, Math.max(1, u * 0.4));
    }
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

  /* Кірка. x,y — центр у пікселях, size — в пікселях, rot — радіани */
  pickaxe(ctx: Ctx, x: number, y: number, size: number, tier: Tier, rot: number, enchanted: boolean) {
    const img = Assets.pick(tier, enchanted);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot || 0);

    if (enchanted) {
      ctx.shadowColor = '#c46bff';
      ctx.shadowBlur = size * 0.28;
    }

    if (img) {
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
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

  /* «Пусто» — поки просто Х. Дай іконку — заміню на неї. */
  cross(ctx: Ctx, x: number, y: number, size: number, alpha = 1) {
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

  /* Квадратна комірка-символ рулетки — як у класичному 777-слоті:
     сам символ великий і по центру, назва — тонким підписом знизу
     (пусто підпису не має, там і так усе зрозуміло з хреста). */
  /* Символ стрічки. БЕЗ власної підкладки: раніше тут був inset() —
     квадрат кольору тіру з фаскою. Під прямокутною рамкою він читався
     як комірка автомата, але всередині круглого вінка квадрат у колі
     виглядає чужорідно. Тепер кірка лежить просто на фоні екрана, а
     роль вікна виконує сама рамка.

     Підсвітка виграшної комірки лишається, але кружком, а не заливкою
     прямокутника — інакше квадрат повернувся б у момент зупинки. */
  reelItem(ctx: Ctx, x: number, y: number, w: number, h: number, item: ReelItem, hot: boolean) {
    if (hot) {
      const cx0 = x + w / 2, cy0 = y + h / 2, r = Math.min(w, h) * 0.52;
      const g = ctx.createRadialGradient(cx0, cy0, r * 0.2, cx0, cy0, r);
      g.addColorStop(0, 'rgba(255,211,77,.22)');
      g.addColorStop(1, 'rgba(255,211,77,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx0, cy0, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const cx = x + w / 2;
    const label = !!item && h > w * 0.6;   // на дуже вузькій комірці підпис не влізе
    const iconCy = label ? y + h * 0.42 : y + h / 2;
    const s = Math.min(w, h) * (label ? 0.62 : 0.74);

    if (!item) this.cross(ctx, cx, iconCy, s * 0.58, 0.95);
    else this.pickaxe(ctx, cx, iconCy, s, item, -0.5, false);

    if (label) {
      const small = Math.round(Math.min(w, h) * 0.15);
      this.text(ctx, item!.name.toUpperCase(), cx, y + h * 0.86,
        '700 ' + small + 'px ui-monospace, monospace', '#fff');
    }
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
};
