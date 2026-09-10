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

/* Геометрія рамки (public/ui/reel-frame.png, 1024x1024) — заміряно з самого
   файлу по альфа-каналу, а не на око: вінок несиметричний, листя
   стирчить усередину, і виріз у ньому не рівне коло й не по центру
   зображення. Координати вікна — частка від повних розмірів рамки, щоб
   масштабування на будь-який екран лишалось коректним.

   ВІКНО — КОЛО, А НЕ ВПИСАНИЙ КВАДРАТ.

   Спершу тут стояв найбільший квадрат, що влазить у виріз (446 px), і
   між ним та вінком лишалось кільце порожнечі — фон слота обривався,
   не доходячи до рамки. Тепер стрічка малюється диском по самому
   вирізу й обрізається по ньому: фон іде впритул до вінка, а зайве
   ховає сама рамка, бо вона малюється ПОВЕРХ стрічки.

   Центр і радіус заміряно з файлу (центроїд вирізу й найдальший його
   піксель): 512.1, 537.0 і 435 px при 1024 px рамки. Центр нижчий за
   середину картинки — згори всередину звисає корона великого каменя.

   Ідеального «нічого не витікає» тут не буває: у вінку є щілини між
   листям, і крізь них видно те, що позаду. Але текстура фону темна
   (#1f1f23) і майже збігається з тлом за рамкою, тож на око щілини
   лишаються щілинами. */
const FRAME_W = 1024, FRAME_H = 1024;
export const FRAME_ASPECT = FRAME_W / FRAME_H;

/** центр вирізу — частка від розмірів рамки */
export const FRAME_WIN_CX = 0.5001;
export const FRAME_WIN_CY = 0.5244;
/** радіус вирізу — частка ШИРИНИ рамки, з невеликим запасом */
export const FRAME_WIN_R = 0.4297;

/* Габарити вікна для presenter: він рахує розмір комірки як різницю
   цих часток, тому тут просто описовий прямокутник кола. */
export const FRAME_INNER_LEFT = FRAME_WIN_CX - FRAME_WIN_R;
export const FRAME_INNER_RIGHT = FRAME_WIN_CX + FRAME_WIN_R;
export const FRAME_INNER_TOP = FRAME_WIN_CY - FRAME_WIN_R;
export const FRAME_INNER_BOTTOM = FRAME_WIN_CY + FRAME_WIN_R;

/* ============================================================
   КАМЕНІ НА ВІНКУ — прогрес до гарантованої кірки.

   Раніше це була текстова пігулка «3/7 до гарантии» під полем. Тепер
   те саме показує сама рамка: за кожну пусту ставку загорається
   черговий рубін, останнім — великий зверху, і разом з ним усі
   стають зеленими: наступний прокрут гарантовано дає кірку.

   Позиції заміряно з файлу пошуком червоних плям (частки від ширини
   рамки), а не виставлено вручну. Малих каменів рівно 6, великий 1 —
   разом 7, і це не збіг: CONFIG.pity теж 7. Якщо pity колись стане
   іншим, малюємо min(pity, 6) малих — див. gemsFor().
   ============================================================ */
type Ctx = CanvasRenderingContext2D;

interface Gem { x: number; y: number; r: number }

/* Порядок — за годинниковою стрілкою від великого каменя, щоб вінок
   заповнювався до корони, а не стрибав із боку в бік. */
const GEMS_SMALL: readonly Gem[] = [
  { x: 0.7737, y: 0.2415, r: 0.0322 },   // праворуч угорі
  { x: 0.9127, y: 0.5097, r: 0.0312 },   // праворуч
  { x: 0.7732, y: 0.7857, r: 0.0312 },   // праворуч унизу
  { x: 0.2275, y: 0.7861, r: 0.0312 },   // ліворуч унизу
  { x: 0.0882, y: 0.5099, r: 0.0312 },   // ліворуч
  { x: 0.2276, y: 0.2415, r: 0.0322 },   // ліворуч угорі
];
const GEM_BIG: Gem = { x: 0.5001, y: 0.1294, r: 0.0498 };

const RED = { core: '#ff5a4a', glow: '255,70,55' };
const GREEN = { core: '#7dff9a', glow: '90,255,120' };

/* Скільки місця в картинці зеленого рубіна займає сам камінь: заміряно
   з файлу — 0.752 полотна, решта прозора. Щоб камінь накрив червоний
   радіуса r, картинку треба малювати ширшою: 2r / 0.752, плюс запас
   на бортик гнізда. */
const GEM_ART_FILL = 0.752;
/* Запас підібрано перебором по самій картинці, а не на око: при 1.12 з-під
   зеленого лишалось 14 червоних пікселів по краю гнізда, при 1.18 — жодного.
   Беремо 1.22, щоб дрібне згладжування на масштабуванні теж нічого не
   лишило. */
const GEM_ART_MARGIN = 1.22;
const GEM_ART_K = (2 / GEM_ART_FILL) * GEM_ART_MARGIN;

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

  /* Скільки малих каменів під цей поріг pity. Великий завжди останній,
     тож малих — на один менше. Більше шести на вінку немає. */
  private gemsFor(need: number): readonly Gem[] {
    return GEMS_SMALL.slice(0, Math.max(0, Math.min(GEMS_SMALL.length, need - 1)));
  }

  /* КАМЕНІ ПРОГРЕСУ. Малюються ПОВЕРХ рамки, тому окремим методом:
     всередині draw() вони лягли б під саме зображення вінка.

     got — пустих ставок поспіль, need — поріг гарантії (CONFIG.pity).
     t — час у секундах, від нього живе пульс.
     justLit — індекс каменя, що загорівся щойно (-1, якщо ні): він
     спалахує яскравіше, щоб подію було видно, а не лише новий стан.

     Камені вже намальовані червоними на самій картинці, тому:
       - згаслі приглушуємо темним кружком, інакше «горить» і «не
         горить» не відрізнити;
       - зелений стан ЗАКРИВАЄ рубін непрозорим кружком, а не тонує
         поверх: додавання зеленого до червоного дає брудно-жовтий. */
  drawGems(
    ctx: Ctx, cx: number, cy: number, frameW: number, frameH: number,
    got: number, need: number, t: number, justLit = -1,
  ): void {
    const small = this.gemsFor(need);
    const all: Gem[] = [...small, GEM_BIG];
    const done = got >= need;
    const lit = done ? all.length : Math.min(got, small.length);
    const paint = done ? GREEN : RED;

    const x0 = cx - frameW / 2;
    const y0 = cy - frameH / 2;

    for (let i = 0; i < all.length; i++) {
      const g = all[i];
      const gx = x0 + frameW * g.x;
      const gy = y0 + frameH * g.y;
      const gr = frameW * g.r;
      const isBig = i === all.length - 1;
      const on = i < lit;

      if (!on) {
        // приглушуємо ще не зароблений камінь
        ctx.save();
        ctx.globalAlpha = 0.62;
        ctx.fillStyle = '#0a0d12';
        ctx.beginPath();
        ctx.arc(gx, gy, gr * 0.92, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      /* Пульс. Великий камінь дихає повільніше — він тут головний, і
         спільний ритм зі шістьма малими читався б як миготіння. */
      const speed = isBig ? 2.2 : 3.1;
      const phase = isBig ? 0 : i * 0.7;   // мала розсинхронізація по колу
      let pulse = 0.72 + 0.28 * Math.sin(t * speed + phase);
      if (done) pulse = 0.82 + 0.18 * Math.sin(t * 3.4 + i * 0.5);
      if (i === justLit) pulse = 1;

      ctx.save();

      /* ЗЕЛЕНИЙ СТАН: червоний рубін треба саме ПЕРЕКРИТИ, а не
         підфарбувати — додавання зеленого до червоного дало б брудно-
         жовтий. Кладемо картинку зеленого каменя непрозоро.

         Непрозорість тут не косметика, а умова: миготіння робимо
         СВІТІННЯМ поверх, а не прозорістю самого каменя. Якби пульс
         гнав альфу картинки, у кожній «темній» фазі з-під неї
         проступав би червоний. */
      if (done) {
        const art = Assets.get('gemGreen');
        if (art) {
          const size = gr * GEM_ART_K;
          ctx.drawImage(art, gx - size / 2, gy - size / 2, size, size);
        } else {
          // картинки немає — лишається намальований кружок, теж непрозорий
          ctx.fillStyle = '#1d7a3a';
          ctx.beginPath();
          ctx.arc(gx, gy, gr * 1.02, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = paint.core;
          ctx.globalAlpha = 0.85;
          ctx.beginPath();
          ctx.arc(gx, gy, gr * 0.55, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // саме світіння — додаванням, щоб камінь горів, а не був залитий
      ctx.globalCompositeOperation = 'lighter';
      const R = gr * (done ? 3.1 : 2.4) * (0.85 + 0.15 * pulse);
      const grd = ctx.createRadialGradient(gx, gy, gr * 0.15, gx, gy, R);
      grd.addColorStop(0, `rgba(${paint.glow},${(0.85 * pulse).toFixed(3)})`);
      grd.addColorStop(0.35, `rgba(${paint.glow},${(0.34 * pulse).toFixed(3)})`);
      grd.addColorStop(1, `rgba(${paint.glow},0)`);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(gx, gy, R, 0, Math.PI * 2);
      ctx.fill();

      /* Ядро — щоб камінь читався як джерело, а не як пляма навколо.
         У зеленому стані б'ємо по самому каменю: це і є миготіння, і
         воно накладається ПОВЕРХ непрозорої картинки. */
      ctx.fillStyle = paint.core;
      ctx.globalAlpha = (done ? 0.42 : 0.5) * pulse;
      ctx.beginPath();
      ctx.arc(gx, gy, gr * (done ? 0.82 : 0.5), 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
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
    // центр і радіус вирізу в екранних пікселях
    const winCx = frameX + frameW * FRAME_WIN_CX;
    const winCy = frameY + frameH * FRAME_WIN_CY;
    const winR = frameW * FRAME_WIN_R;

    ctx.save();
    ctx.globalAlpha = alpha;

    /* Підкладки під стрічку немає навмисно.

       Раніше тут була Render.inset() — темний квадрат із фаскою, а
       нижче золоті кутики лінії виплати. Під прямокутною рамкою вони
       читались як частина автомата, але всередині круглого вінка
       квадрат сидить чужорідною плямою: рамка вже й є вікном, а другу
       рамку в неї вписувати нема за чим. Символ лягає просто на фон
       екрана. */

    /* Стрічка обрізається КОЛОМ вирізу, а не прямокутником: інакше
       кути прямокутника вилізли б за вінок, а його боки не дістали б
       до нього — те саме кільце порожнечі, від якого й тікаємо. */
    ctx.save();
    ctx.beginPath();
    ctx.arc(winCx, winCy, winR, 0, Math.PI * 2);
    ctx.clip();

    /* ФОН СЛОТА — тільки тут, усередині вікна, і розтягнутий на всю
       його площу. Раніше та сама текстура заливала весь екран; фон
       належить слоту, а не кадру. */
    const bg = Assets.get('slotBg');
    if (bg) {
      ctx.drawImage(bg, winCx - winR, winCy - winR, winR * 2, winR * 2);
    } else {
      ctx.fillStyle = '#1f1f23';
      ctx.fillRect(winCx - winR, winCy - winR, winR * 2, winR * 2);
    }

    const cyWin = y + winH / 2;
    const first = Math.max(0, Math.floor(this.offset) - Math.ceil(R.visible / 2) - 1);
    const last = Math.min(this.items.length - 1, first + R.visible + 3);
    for (let i = first; i <= last; i++) {
      const iy = cyWin - itemH / 2 + (i - this.offset) * itemH;
      const hot = !this.spinning && Math.abs(i - this.offset) < 0.5;
      /* Комірка = точні габарити вікна. Колишні відступи +5/+4 були
         полями старої підкладки; без неї вони лише зсували символ. */
      Render.reelItem(ctx, x, iy, itemW, itemH, this.items[i], hot);
    }

    /* Згасання країв прибрано: стрічку тепер обрізає коло вирізу, і рівно
       по цьому колу починається вінок. Обрив ховає сама рамка, тож
       затемнювати край — значить темнити символ без причини. */

    ctx.restore();

    // сама рамка — ПОВЕРХ стрічки, прозорий центр показує її знизу.
    // Якщо файл не завантажився — запасний варіант, стара процедурна рама.
    const img = Assets.get('reelFrame');
    if (img) ctx.drawImage(img, frameX, frameY, frameW, frameH);
    else Render.wood(ctx, x - 18, y - 18, itemW + 36, winH + 36);

    /* Золотих кутиків лінії виплати теж немає: у вікні тепер один
       символ, тобто лінія виплати — саме воно. Позначати рамкою те, що
       й так єдине видиме, нема сенсу. */

    ctx.restore();
  }
}
