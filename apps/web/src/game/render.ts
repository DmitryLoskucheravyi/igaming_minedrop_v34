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
      '800 ' + Math.round(s * (m >= 100 ? 0.3 : 0.42)) + 'px ui-monospace, monospace', '#fff8dc');
  },

  /* Блок. cell = { id, dmg, seed, m } */
  block(ctx: Ctx, x: number, y: number, s: number, cell: Cell) {
    const def = BLOCKS[cell.id];
    if (def.kind === 'mult') { this.multBlock(ctx, x, y, s, cell.m || 2); return; }
    const img = Assets.get('block.' + cell.id);
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
    let st = ((seed | 0) * 2654435761 % 2147483647) || 12345;
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
  reelItem(ctx: Ctx, x: number, y: number, w: number, h: number, item: ReelItem, hot: boolean) {
    this.inset(ctx, x, y, w, h, item ? item.color2 : '#242b35', 4);
    if (hot) {
      ctx.fillStyle = 'rgba(255,211,77,.16)';
      ctx.fillRect(x, y, w, h);
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
