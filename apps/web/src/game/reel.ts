/* ============================================================
   REEL — вертикальна рулетка, як у класичному слоті 777: одна
   стрічка символів, квадратні комірки, у вікні видно три —
   над лінією виплати, на ній (підсвічена золотими кутами) і під.

   ВАЖЛИВО, ЩО ЗМІНИЛОСЬ У КЛІЄНТ-СЕРВЕРНІЙ ВЕРСІЇ
   Рулетка більше нічого не вирішує. Що випаде — вже написано в
   відповіді сервера; сюди приходить готовий переможець, і рулетка
   лише красиво до нього доїжджає.

   Тому Math.random() тут лишився і це нормально: ним набиваються
   комірки, які проносяться повз і зникають. На результат вони не
   впливають, у сид не входять і на сервері не існують.
   ============================================================ */

import { bonusReelTable, CONFIG, reelTable } from '@minedrop/engine';
import { Render, type ReelItem } from './render';

export class Reel {
  items: ReelItem[] = [];
  offset = 0;
  spinning = false;
  bonusMode = false;

  private t = 0;
  // явний number: CONFIG оголошений as const, тому spinMs має літеральний тип
  private ms: number = CONFIG.reel.spinMs;
  private from = 0;
  private to = 0;
  private result: ReelItem = null;
  private onDone: ((item: ReelItem) => void) | null = null;

  constructor() { this.idle(); }

  /* Декоративна комірка — тільки для стрічки, що проноситься повз */
  private filler(bonus = false): ReelItem {
    const table = bonus ? bonusReelTable() : reelTable();
    let total = 0;
    for (const s of table) total += s.weight;
    let x = Math.random() * total;
    for (const s of table) { x -= s.weight; if (x <= 0) return s.tier; }
    return null;
  }

  idle(): void {
    const R = CONFIG.reel;
    this.items = [];
    for (let i = 0; i < R.stripLen; i++) this.items.push(this.filler());
    this.offset = R.targetIndex;
    this.spinning = false;
  }

  /** winner — те, що вже вирішив сервер. ms — тривалість прокруту. */
  start(winner: ReelItem, onDone: (item: ReelItem) => void, ms?: number): void {
    const R = CONFIG.reel;
    this.result = winner;
    this.onDone = onDone;
    this.ms = ms ?? R.spinMs;

    this.items = [];
    for (let i = 0; i < R.stripLen; i++) this.items.push(this.filler(this.bonusMode));
    this.items[R.targetIndex] = winner;      // переможець стоїть на targetIndex

    this.from = 0;
    this.to = R.targetIndex;
    this.offset = 0;
    this.t = 0;
    this.spinning = true;
  }

  update(dt: number): void {
    if (!this.spinning) return;
    this.t += dt;
    const p = Math.min(1, this.t / (this.ms / 1000));
    const e = 1 - Math.pow(1 - p, 5);                 // різкий старт, м'яка посадка
    this.offset = this.from + (this.to - this.from) * e;
    if (p >= 1) {
      this.spinning = false;
      const f = this.onDone;
      this.onDone = null;
      f?.(this.result);
    }
  }

  /* cx, cy — центр вікна рулетки */
  draw(ctx: CanvasRenderingContext2D, cx: number, cy: number, itemW: number, itemH: number, alpha = 1): void {
    const R = CONFIG.reel;
    const winH = itemH * R.visible;
    const x = cx - itemW / 2;
    const y = cy - winH / 2;
    const pad = 18;

    ctx.save();
    ctx.globalAlpha = alpha;

    // дерев'яна рама
    Render.wood(ctx, x - pad, y - pad, itemW + pad * 2, winH + pad * 2);

    // темна ніша під стрічку
    Render.inset(ctx, x - 6, y - 6, itemW + 12, winH + 12, '#12151b', 5);

    // сама стрічка
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, itemW, winH);
    ctx.clip();

    const first = Math.max(0, Math.floor(this.offset) - Math.ceil(R.visible / 2) - 1);
    const last = Math.min(this.items.length - 1, first + R.visible + 3);
    for (let i = first; i <= last; i++) {
      const iy = cy - itemH / 2 + (i - this.offset) * itemH;
      const hot = !this.spinning && Math.abs(i - this.offset) < 0.5;
      Render.reelItem(ctx, x + 5, iy + 4, itemW - 10, itemH - 8, this.items[i], hot);
    }

    // затемнення зверху/знизу
    const gt = ctx.createLinearGradient(0, y, 0, y + itemH);
    gt.addColorStop(0, 'rgba(10,12,16,.96)');
    gt.addColorStop(1, 'rgba(10,12,16,0)');
    ctx.fillStyle = gt;
    ctx.fillRect(x, y, itemW, itemH);
    const gb = ctx.createLinearGradient(0, y + winH, 0, y + winH - itemH);
    gb.addColorStop(0, 'rgba(10,12,16,.96)');
    gb.addColorStop(1, 'rgba(10,12,16,0)');
    ctx.fillStyle = gb;
    ctx.fillRect(x, y + winH - itemH, itemW, itemH);
    ctx.restore();

    // золоті куточки на виграшній комірці
    const sy = cy - itemH / 2;
    const L = Math.min(26, itemH * 0.36);
    const th = 5;
    ctx.fillStyle = '#ffd34d';
    const corners: [number, number, number, number][] = [
      [x, sy, L, th], [x, sy, th, L],
      [x + itemW - L, sy, L, th], [x + itemW - th, sy, th, L],
      [x, sy + itemH - th, L, th], [x, sy + itemH - L, th, L],
      [x + itemW - L, sy + itemH - th, L, th], [x + itemW - th, sy + itemH - L, th, L],
    ];
    for (const r of corners) ctx.fillRect(r[0], r[1], r[2], r[3]);

    // стрілки по боках
    ctx.fillStyle = '#ffd34d';
    ctx.strokeStyle = '#0d0f13';
    ctx.lineWidth = 3;
    const a = 15;
    for (const [px, dir] of [[x - 10, 1], [x + itemW + 10, -1]] as [number, number][]) {
      ctx.beginPath();
      ctx.moveTo(px, cy);
      ctx.lineTo(px - dir * a, cy - a);
      ctx.lineTo(px - dir * a, cy + a);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }
}
