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

import { CONFIG, reelTable } from '@minedrop/engine';
import { Assets } from './assets';
import { Render, type ReelItem } from './render';

/* Геометрія рамки (public/рамка.png, 941x1672 — вужча версія) —
   заміряно з самого файлу (аналіз альфа-каналу): прозорий центр НЕ
   рівно по центру зображення, тому координати внутрішнього вікна
   беремо як частку від повних розмірів рамки, а не як фіксований
   відступ у пікселях (щоб масштабування на будь-який розмір екрана
   лишалось коректним). */
const FRAME_W = 941, FRAME_H = 1672;
export const FRAME_ASPECT = FRAME_W / FRAME_H;
export const FRAME_INNER_LEFT = 0.133;
export const FRAME_INNER_RIGHT = 0.869;
export const FRAME_INNER_TOP = 0.068;
export const FRAME_INNER_BOTTOM = 0.910;

export class Reel {
  items: ReelItem[] = [];
  offset = 0;
  spinning = false;

  private t = 0;
  // явний number: CONFIG оголошений as const, тому spinMs має літеральний тип
  private ms: number = CONFIG.reel.spinMs;
  private from = 0;
  private to = 0;
  private result: ReelItem = null;
  private onDone: ((item: ReelItem) => void) | null = null;

  constructor() { this.idle(); }

  /* Декоративна комірка — тільки для стрічки, що проноситься повз */
  private filler(): ReelItem {
    const table = reelTable();
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
    /* На лінії виплати в спокої — завжди «пусто». Філер там ставив
       випадковий символ, і приблизно в кожному шостому випадку рулетка
       ще до прокруту показувала кірку в рамці — виглядало так, ніби
       щойно щось виграно. */
    this.items[R.targetIndex] = null;
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
    for (let i = 0; i < R.stripLen; i++) this.items.push(this.filler());
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

  /* cx, cy — центр усієї рамки. frameW/frameH — розмір самого зображення
     рамки (фіксоване співвідношення сторін). itemW/itemH — розмір ОДНІЄЇ
     комірки стрічки всередині прозорого вікна рамки (їх рахує presenter
     з тих самих FRAME_INNER_* пропорцій, щоб не дублювати геометрію). */
  draw(ctx: CanvasRenderingContext2D, cx: number, cy: number,
    frameW: number, frameH: number, itemW: number, itemH: number, alpha = 1): void {
    const R = CONFIG.reel;
    const winH = itemH * R.visible;
    const frameX = cx - frameW / 2;
    const frameY = cy - frameH / 2;
    const x = frameX + frameW * FRAME_INNER_LEFT;
    const y = frameY + frameH * FRAME_INNER_TOP;

    ctx.save();
    ctx.globalAlpha = alpha;

    // темний фон під стрічку — видно крізь прозорий центр рамки
    Render.inset(ctx, x - 4, y - 4, itemW + 8, winH + 8, '#12151b', 4);

    // сама стрічка, обрізана прозорим вікном рамки
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, itemW, winH);
    ctx.clip();

    const cyWin = y + winH / 2;
    const first = Math.max(0, Math.floor(this.offset) - Math.ceil(R.visible / 2) - 1);
    const last = Math.min(this.items.length - 1, first + R.visible + 3);
    for (let i = first; i <= last; i++) {
      const iy = cyWin - itemH / 2 + (i - this.offset) * itemH;
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

    // сама рамка — ПОВЕРХ стрічки, прозорий центр показує її знизу.
    // Якщо файл не завантажився — запасний варіант, стара процедурна рама.
    const img = Assets.get('reelFrame');
    if (img) ctx.drawImage(img, frameX, frameY, frameW, frameH);
    else Render.wood(ctx, x - 18, y - 18, itemW + 36, winH + 36);

    // золоті куточки на виграшній комірці (лінія виплати — середня)
    const sy = cyWin - itemH / 2;
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

    ctx.restore();
  }
}
