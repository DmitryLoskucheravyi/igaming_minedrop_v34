/* ============================================================
   REEL — вертикальна рулетка, як у класичному слоті 777: одна
   стрічка символів, у круглому вікні видно один — той, що на лінії
   виплати.

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

/* ============================================================
   ГЕОМЕТРІЯ КІЛЬЦЯ (public/ui/reel-frame.png, 553x560)

   Усі числа нижче ЗАМІРЯНО з самого файлу (альфа-канал), а не
   виставлено на око. Координати — у частках розмірів кільця, щоб
   масштабування на будь-який екран лишалось коректним.

   Непрозорий bbox: x 3..551, y 2..554. Центр вирізу (центр маси
   прозорої плями всередині) — 276.7, 277.8.

   ВІКНО — КОЛО, А НЕ ВПИСАНИЙ КВАДРАТ. Стрічка малюється диском по
   самому вирізу й обрізається по ньому, а кільце лягає ПОВЕРХ неї —
   тоді фон слота йде впритул до кільця, а зайве ховає саме кільце.

   Два різні радіуси, і плутати їх не можна:
     FRAME_WIN_R — МЕДІАНА краю вирізу (184.5 px). З неї presenter
       рахує розмір комірки стрічки, тож вона задає видимий калібр
       символів і має лишатись близькою до старої.
     CLIP_R — МАКСИМУМ (виріз намальований від руки й доходить до
       195.1 px). По ньому обрізається стрічка з підкладкою. Менше
       брати не можна: між краєм диска й кільцем лишилась би прозора
       серпанка, крізь яку видно шахту. Зайве зверху безкоштовне —
       його однаково накриває непрозоре кільце.

   Зелені стрілки лінії виплати намальовані ВСЕРЕДИНІ картинки — вони
   дивляться всередину зліва й справа. Нічого поверх них не треба.
   ============================================================ */
const FRAME_W = 553, FRAME_H = 560;
export const FRAME_ASPECT = FRAME_W / FRAME_H;

/** центр вирізу — частка від розмірів кільця */
export const FRAME_WIN_CX = 0.5004;   // 276.7 / 553
export const FRAME_WIN_CY = 0.4961;   // 277.8 / 560
/** медіанний радіус вирізу — частка ШИРИНИ кільця (калібр комірки) */
export const FRAME_WIN_R = 0.3336;    // 184.5 / 553
/** радіус обрізання стрічки — з запасом на найширше місце вирізу */
const CLIP_R = 0.3545;                // 196 / 553

/* Габарити вікна для presenter: він рахує розмір комірки як різницю
   цих часток, тому тут просто описовий прямокутник кола. */
export const FRAME_INNER_LEFT = FRAME_WIN_CX - FRAME_WIN_R;
export const FRAME_INNER_RIGHT = FRAME_WIN_CX + FRAME_WIN_R;
export const FRAME_INNER_TOP = FRAME_WIN_CY - FRAME_WIN_R;
export const FRAME_INNER_BOTTOM = FRAME_WIN_CY + FRAME_WIN_R;

/* ============================================================
   СЕГМЕНТИ КІЛЬЦЯ — прогрес до гарантованої кірки.

   Раніше це була текстова пігулка «3/7 до гарантии», потім рубіни на
   вінку, потім намальовані палички — по картинці на сегмент. Тепер
   САМЕ КІЛЬЦЕ має сім ВИРІЗАНИХ сегментів (у png вони прозорі), і
   колір їм дає заливка ЗНИЗУ: за кожну пусту ставку чергова дуга
   стає червоною, а коли набралось на гарантію — усі сім зеленіють.

   Сегментів рівно СІМ, і це не збіг: CONFIG.pity теж 7. Один сегмент
   = одна пуста ставка.

   ---- ЧОМУ ЗАЛИВКА, А НЕ КАРТИНКИ ----
   Дірку в кільці не можна лишити порожньою: крізь неї видно шахту.
   Тому під кільцем завжди лежить підкладка — усі сім дуг, навіть ще
   не зароблені (SEG_EMPTY, темний тон самого кільця). Стан сегмента —
   це просто ІНШИЙ КОЛІР тієї ж дуги, а не інша картинка. Через це
   зникли одинадцять pip-*.png, перефарбовування форми сусіднього
   кольору й пошук прямокутника під кожну паличку.

   ПОРЯДОК КАДРУ ЗМІНИВСЯ: заливка йде ПІД кільце, тобто ПЕРЕД ним
   (раніше палички малювались ПОВЕРХ, бо панель була непрозора).
   Звідси й presenter кличе drawSegments до draw, а не після.

   ---- звідки кути ----
   Заміряно з альфи: кожна прозора пляма — окрема зв'язна компонента,
   з неї взято кутовий діапазон від центру вирізу. Перемички між
   сегментами вузькі (3.4°..5.2°), тому дуги розширені на SEG_PAD з
   кожного боку: це ховає зубці згладжування по краю вирізу й усе одно
   лишається під непрозорою перемичкою.
   ============================================================ */
type Ctx = CanvasRenderingContext2D;

/** порожній сегмент — темний тон самого кільця (заміряно по файлу) */
const SEG_EMPTY = '#1e2740';
/** зароблена пуста ставка / набрана гарантія */
const PIP_RED = '#d83838';
const PIP_GREEN = '#24e35f';

/* Смуга сегментів у частках ШИРИНИ кільця. Дірки лежать на r
   207..260; беремо 200..266 — ширше з обох боків, щоб заливка гарантовано
   перекрила виріз. Знизу впирається у виріз вікна (195), зверху — у
   зовнішній край кільця (269), тож перебір нікуди не вилазить. */
const SEG_R = 0.4213;   // (200+266)/2 / 553
const SEG_W = 0.1193;   // (266-200)   / 553
const SEG_PAD = 1.5;    // градуси запасу з кожного боку дуги

/* Кутові межі семи вирізів (градуси, canvas-конвенція: 0° = праворуч,
   кут росте ЗА годинниковою, бо вісь y дивиться вниз).

   Порядок — ПОРЯДОК ЗАПОВНЕННЯ: за годинниковою, починаючи з сегмента
   одразу після верхньої перемички (вона стоїть рівно вгорі, на 270°).
   Кроки нерівномірні — кільце намальоване від руки, рівних 360/7 тут
   немає. */
interface Seg { a0: number; a1: number }
const SEGMENTS: readonly Seg[] = [
  { a0: 272.5, a1: 319.9 },
  { a0: 323.4, a1: 366.5 },   // перетинає 0°, тому 6.5 записано як 366.5
  { a0: 10.8, a1: 60.4 },
  { a0: 63.7, a1: 115.4 },
  { a0: 119.5, a1: 169.2 },
  { a0: 173.5, a1: 216.6 },
  { a0: 220.1, a1: 267.4 },
];


/* ---- ПІДКЛАДКА ПІД СТРІЧКУ (ui/reel-backing.png) ----
   Заміряно з файлу: полотно 589x561, непрозорий bbox x 12..577,
   y 32..560 (тобто поля є, і несиметричні), центр диска 294.5, 296.

   BACKING_SAFE_R — найменший радіус від центру, на якому диск ще
   СУЦІЛЬНО непрозорий у ВСІХ напрямках (по променях: 247.5 px). Диск
   намальований від руки й не є ідеальним колом, тому масштабувати
   треба саме за цим радіусом, а не за габаритами картинки: інакше між
   краєм підкладки й кільцем лишається щілина.

   BACKING_OVER — запас понад радіус вирізу. Зайве однаково зрізає
   кліп по колу, тож перебір нічого не коштує. */
const BACKING_W = 589, BACKING_H = 561;
const BACKING_CX = 294.5, BACKING_CY = 296;
const BACKING_SAFE_R = 247.5;
const BACKING_OVER = 1.06;

/* Спалах щойно засвіченого сегмента: розгорається й гасне за 250 мс.
   Пульсацію «дихання» всіх сегментів прибрано разом із рубінами: сім
   сегментів, що дихають одночасно, читались як миготіння екрана. */
const PIP_FLASH_SEC = 0.25;
/** наскільки додається яскравості на піку спалаху */
const PIP_FLASH_GLOW = 0.55;
/* Перехід у зелений стан — хвиля по колу, стільки секунд на сегмент. */
const PIP_WAVE_SEC = 0.06;

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

  /* Коли саме сталась подія, за годинником малювання (t у drawSegments).
     Тримаємо ТУТ, а не в презентері, бо це чиста анімація й нікому
     більше не потрібна: презентер віддає лише СТАН (got/need/justLit),
     а скільки триває спалах і хвиля — справа самого кільця.
     -1 — події ще не було. */
  private doneAt = -1;
  private litIdx = -1;
  private litAt = -1;

  /* Скільки сегментів ПОКАЗУЄ СТАН. Вирізів на кільці рівно сім, тому
     якщо CONFIG.pity колись стане іншим, більше семи ми все одно не
     розфарбуємо. Решта вирізів від цього не зникає — вони так само
     заливаються підкладкою, інакше крізь них було б видно шахту. */
  private segsFor(need: number): number {
    return Math.max(0, Math.min(SEGMENTS.length, need));
  }

  /* ПРОГРЕС ДО ГАРАНТІЇ — заливка вирізів кільця.

     Малюється ПІД кільцем, тобто ПЕРЕД ним: сегменти в png прозорі, і
     кольором їх робить саме ця заливка. Порядок кадру:
       сегменти -> підкладка+стрічка (кліп по колу) -> кільце.

     Усі сім дуг малюються ЗАВЖДИ. Ще не зароблений сегмент отримує
     SEG_EMPTY — це і є та підкладка, без якої в дірці світилась би
     шахта. «Зароблено» — це просто інший колір тієї самої дуги.

     got — пустих ставок поспіль, need — поріг гарантії (CONFIG.pity).
     t — час у секундах (реальний, не прискорений).
     justLit — індекс сегмента, що загорівся щойно (-1, якщо ні). */
  drawSegments(
    ctx: Ctx, cx: number, cy: number, frameW: number, frameH: number,
    got: number, need: number, t: number, justLit = -1,
  ): void {
    const shown = this.segsFor(need);
    const done = got >= need;

    // хвиля перефарбування в зелений стартує в момент переходу
    if (done && this.doneAt < 0) this.doneAt = t;
    if (!done) this.doneAt = -1;
    // спалах — у момент, коли презентер уперше назвав новий індекс
    if (justLit >= 0 && justLit !== this.litIdx) { this.litIdx = justLit; this.litAt = t; }
    if (justLit < 0) this.litIdx = -1;

    const x0 = cx - frameW / 2;
    const y0 = cy - frameH / 2;
    const winCx = x0 + frameW * FRAME_WIN_CX;
    const winCy = y0 + frameH * FRAME_WIN_CY;
    const r = frameW * SEG_R;

    // скільки сегментів уже позеленіло (хвиля по черзі, за годинниковою)
    const greenN = done
      ? Math.min(shown, Math.floor((t - this.doneAt) / PIP_WAVE_SEC) + 1)
      : 0;

    ctx.save();
    ctx.lineWidth = frameW * SEG_W;
    ctx.lineCap = 'butt';

    for (let i = 0; i < SEGMENTS.length; i++) {
      const seg = SEGMENTS[i];
      const on = i < shown && (done || i < got);
      const green = i < greenN;
      const color = !on ? SEG_EMPTY : green ? PIP_GREEN : PIP_RED;

      const a0 = ((seg.a0 - SEG_PAD) * Math.PI) / 180;
      const a1 = ((seg.a1 + SEG_PAD) * Math.PI) / 180;

      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(winCx, winCy, r, a0, a1);
      ctx.stroke();

      /* Спалах щойно зарахованої ставки. Раніше паличка «дихала»
         розміром; вирізу так не зробиш — він нерухомий, — тому
         спалах тепер яскравістю: та сама дуга ще раз, додаванням.
         Зайве світло однаково зріже непрозоре кільце зверху. */
      if (!on) continue;
      const flash = this.litIdx === i && this.litAt >= 0
        ? Math.max(0, 1 - (t - this.litAt) / PIP_FLASH_SEC)
        : 0;
      if (flash > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = PIP_FLASH_GLOW * Math.sin(flash * Math.PI);
        ctx.beginPath();
        ctx.arc(winCx, winCy, r, a0, a1);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  /* cx, cy — центр усього кільця. frameW/frameH — розмір самого
     зображення кільця (фіксоване співвідношення сторін). itemW/itemH —
     розмір ОДНІЄЇ комірки стрічки всередині прозорого вікна (їх рахує
     presenter із тих самих FRAME_INNER_* пропорцій, щоб не дублювати
     геометрію). */
  draw(ctx: CanvasRenderingContext2D, cx: number, cy: number,
    frameW: number, frameH: number, itemW: number, itemH: number, alpha = 1): void {
    const R = CONFIG.reel;
    const winH = itemH * R.visible;
    const frameX = cx - frameW / 2;
    const frameY = cy - frameH / 2;
    const x = frameX + frameW * FRAME_INNER_LEFT;
    const y = frameY + frameH * FRAME_INNER_TOP;
    // центр вирізу в екранних пікселях
    const winCx = frameX + frameW * FRAME_WIN_CX;
    const winCy = frameY + frameH * FRAME_WIN_CY;
    /* Радіус беремо МАКСИМАЛЬНИЙ (CLIP_R), а не медіанний: диск має
       перекрити виріз у найширшому місці, інакше там лишиться прозора
       щілина. Зайве ховає кільце. */
    const winR = frameW * CLIP_R;

    ctx.save();
    ctx.globalAlpha = alpha;

    /* Стрічка обрізається КОЛОМ вирізу, а не прямокутником: інакше
       кути прямокутника вилізли б за кільце, а його боки не дістали б
       до нього — кільце порожнечі, від якого й тікаємо. */
    ctx.save();
    ctx.beginPath();
    ctx.arc(winCx, winCy, winR, 0, Math.PI * 2);
    ctx.clip();

    /* ПІДКЛАДКА (ui/reel-backing.png) — темний диск під стрічкою,
       тільки всередині вікна.

       Масштабуємо НЕ за розміром файлу, а за BACKING_SAFE_R (див.
       константи вище). Раніше диск вписувався в діаметр вирізу по
       габаритах картинки — а в неї є прозорі поля, та й сам диск не
       ідеально круглий, тому між його краєм і кільцем лишалась
       незакрита щілина. Тепер гарантовано непрозорий радіус диска
       кладеться на радіус вирізу з запасом; усе зайве однаково
       зрізає кліп по колу, тож перебір тут безкоштовний. */
    const bg = Assets.get('reelBacking');
    if (bg) {
      const s = (winR * BACKING_OVER) / BACKING_SAFE_R;
      ctx.drawImage(bg,
        winCx - BACKING_CX * s, winCy - BACKING_CY * s,
        BACKING_W * s, BACKING_H * s);
    } else {
      ctx.fillStyle = '#141a2b';
      ctx.fillRect(winCx - winR, winCy - winR, winR * 2, winR * 2);
    }

    const cyWin = y + winH / 2;
    const first = Math.max(0, Math.floor(this.offset) - Math.ceil(R.visible / 2) - 1);
    const last = Math.min(this.items.length - 1, first + R.visible + 3);
    for (let i = first; i <= last; i++) {
      const iy = cyWin - itemH / 2 + (i - this.offset) * itemH;
      const hot = !this.spinning && Math.abs(i - this.offset) < 0.5;
      Render.reelItem(ctx, x, iy, itemW, itemH, this.items[i], hot);
    }

    ctx.restore();

    /* Саме кільце — ПОВЕРХ усього: прозорий центр показує стрічку, а
       сім прозорих сегментів — заливку прогресу, яку поклав
       drawSegments ДО цього виклику.

       Зелені стрілки лінії виплати вже намальовані ВСЕРЕДИНІ цієї
       картинки (зліва й справа від вирізу), тому окремо покажчик не
       малюємо.

       Файл не завантажився — запасний варіант, стара процедурна рама. */
    const img = Assets.get('reelRing');
    if (img) ctx.drawImage(img, frameX, frameY, frameW, frameH);
    else Render.wood(ctx, x - 18, y - 18, itemW + 36, winH + 36);

    ctx.restore();
  }
}
