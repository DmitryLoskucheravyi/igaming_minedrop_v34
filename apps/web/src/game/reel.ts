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
   ГЕОМЕТРІЯ КІЛЬЦЯ (public/ui/reel-ring.png, 547x561)

   Усі числа нижче ЗАМІРЯНО з самого файлу (альфа-канал + профіль
   яскравості вздовж радіуса), а не виставлено на око. Координати — у
   частках розмірів кільця, щоб масштабування на будь-який екран
   лишалось коректним.

   Непрозорий bbox: x 2..546, y 2..550. Центр отвору (заливка від
   середини по прозорих пікселях): 274, 276.

   ВІКНО — КОЛО, А НЕ ВПИСАНИЙ КВАДРАТ. Стрічка малюється диском по
   самому вирізу й обрізається по ньому, а кільце лягає ПОВЕРХ неї —
   тоді фон слота йде впритул до кільця, а зайве ховає саме кільце.

   Радіус вирізу: медіана «першого непрозорого пікселя» по 3600
   променях = 183.8 px, розкид 180..191 (виріз намальований від руки й
   не є ідеальним колом). Беремо 186 = 0.340 ширини: трохи більше за
   медіану, бо кільце й так накриває край.

   Зелені стрілки лінії виплати намальовані ВСЕРЕДИНІ картинки — на
   цьому кільці вони дивляться всередину зліва й справа. Нічого поверх
   них малювати не треба.
   ============================================================ */
const FRAME_W = 547, FRAME_H = 561;
export const FRAME_ASPECT = FRAME_W / FRAME_H;

/** центр вирізу — частка від розмірів кільця */
export const FRAME_WIN_CX = 0.5009;   // 274 / 547
export const FRAME_WIN_CY = 0.4920;   // 276 / 561
/** радіус вирізу — частка ШИРИНИ кільця */
export const FRAME_WIN_R = 0.3400;    // 186 / 547

/* Габарити вікна для presenter: він рахує розмір комірки як різницю
   цих часток, тому тут просто описовий прямокутник кола. */
export const FRAME_INNER_LEFT = FRAME_WIN_CX - FRAME_WIN_R;
export const FRAME_INNER_RIGHT = FRAME_WIN_CX + FRAME_WIN_R;
export const FRAME_INNER_TOP = FRAME_WIN_CY - FRAME_WIN_R;
export const FRAME_INNER_BOTTOM = FRAME_WIN_CY + FRAME_WIN_R;

/* ============================================================
   ПАЛИЧКИ НА КІЛЬЦІ — прогрес до гарантованої кірки.

   Раніше це була текстова пігулка «3/7 до гарантии», потім рубіни на
   вінку. Тепер те саме показують СЕГМЕНТИ САМОГО КІЛЬЦЯ: за кожну
   пусту ставку в чергову заглиблену панель лягає червона паличка, а
   коли набралось на гарантію — усі сім стають зеленими.

   Сегментів на кільці рівно СІМ, і це не збіг: CONFIG.pity теж 7.
   Один сегмент = одна пуста ставка.

   ---- КОЖНА ПАЛИЧКА — ОКРЕМА КАРТИНКА ----
   Художник намалював їх посегментно: у кожної свій нахил, свій вигин
   і свої пропорції. Тому в коді НЕМАЄ жодного повороту — просто
   drawImage у свій прямокутник. Попередній підхід (одна картинка на
   всі сім + ctx.rotate під кут сегмента) давав видимий перекіс: вигин
   намальованої від руки дуги не збігається з жодним поворотом.

   ---- звідки прямокутники ----
   Знайдено ЗІСТАВЛЕННЯМ, а не на око. З кільця зібрано маску темних
   заглиблених панелей (альфа є, радіус 212..250, яскравість < 72 —
   світліше вже рант або перемичка), а далі для кожної картинки
   перебором масштабу й позиції шукали розкладку, за якої ПЛОЩА
   палички максимально лягає на панель і мінімально повз неї. Числа —
   частки розмірів кільця, тож масштабуються разом із ним.

   ПАНЕЛЬ НЕПРОЗОРА, тому палички малюються ПОВЕРХ кільця, а не під
   ним. Порядок кадру: підкладка -> стрічка (кліп по колу) -> кільце
   -> палички.
   ============================================================ */
type Ctx = CanvasRenderingContext2D;

/* Кути перемичок (градуси, canvas-конвенція: 0° = праворуч, кут росте
   ЗА годинниковою, бо вісь y дивиться вниз). Заміряно як центри
   світлих плям на радіусах 220..245:
     8.65, 62.05, 117.80, 171.35, 218.55, 269.95, 321.40
   Кроки 47.2°..55.8° — кільце намальоване від руки, рівномірних
   360/7 тут немає. Одна перемичка стоїть рівно вгорі (269.95), тому
   заповнення починається з сегмента ОДРАЗУ ПІСЛЯ неї за годинниковою. */

interface PipArt {
  /** ключ в Assets */
  key: string;
  /** прямокутник у частках розмірів кільця */
  x: number; y: number; w: number; h: number;
  /* Картинки саме цього кольору для цього сегмента ще НЕМАЄ, тому
     беремо форму сусіднього кольору й перефарбовуємо суцільним
     заливанням (Assets.tint). Виглядає пласко, зате форма правильна —
     тимчасова заглушка, доки не домалюють три файли. */
  tint?: string;
}
interface PipSeg { deg: number; span: number; green: PipArt; red: PipArt }

/** домінантні кольори самих паличок — заміряно по файлах */
const PIP_GREEN = '#24e35f';
const PIP_RED = '#d83838';

/* Сегменти в ПОРЯДКУ ЗАПОВНЕННЯ: за годинниковою, починаючи з того,
   що йде одразу після верхньої перемички. deg/span потрібні лише для
   затемнення ще не зароблених сегментів. */
const SEGMENTS: readonly PipSeg[] = [
  { deg: 295.67, span: 51.4,
    green: { key: 'pip.green.4', x: 0.5450, y: 0.0480, w: 0.2652, h: 0.1713 },
    red: { key: 'pip.green.4', x: 0.5450, y: 0.0480, w: 0.2652, h: 0.1713, tint: PIP_RED } },
  { deg: 345.02, span: 47.3,
    green: { key: 'pip.green.5', x: 0.8372, y: 0.2529, w: 0.1178, h: 0.2557 },
    red: { key: 'pip.red.6', x: 0.8334, y: 0.2476, w: 0.1222, h: 0.2659 } },
  { deg: 35.35, span: 53.4,
    green: { key: 'pip.green.6', x: 0.7056, y: 0.5992, w: 0.2274, h: 0.2700 },
    red: { key: 'pip.red.7', x: 0.7049, y: 0.5976, w: 0.2301, h: 0.2718 } },
  { deg: 89.92, span: 55.8,
    green: { key: 'pip.red.4', x: 0.3271, y: 0.8431, w: 0.3492, h: 0.0972, tint: PIP_GREEN },
    red: { key: 'pip.red.4', x: 0.3271, y: 0.8431, w: 0.3492, h: 0.0972 } },
  { deg: 144.57, span: 53.5,
    green: { key: 'pip.green.7', x: 0.0673, y: 0.5971, w: 0.2314, h: 0.2722 },
    red: { key: 'pip.red.2', x: 0.0714, y: 0.6012, w: 0.2266, h: 0.2677 } },
  { deg: 194.95, span: 47.2,
    green: { key: 'pip.green.1', x: 0.0452, y: 0.2669, w: 0.1124, h: 0.2515 },
    red: { key: 'pip.red.3', x: 0.0452, y: 0.2636, w: 0.1140, h: 0.2515 } },
  { deg: 244.25, span: 51.4,
    green: { key: 'pip.green.2', x: 0.1912, y: 0.0500, w: 0.2609, h: 0.1688 },
    red: { key: 'pip.green.2', x: 0.1912, y: 0.0500, w: 0.2609, h: 0.1688, tint: PIP_RED } },
];

/* Смуга панелі — потрібна лише щоб притемнити ПОРОЖНІЙ сегмент.
   З радіального профілю: темна заглиблена панель займає r 213..248,
   центр 231, товщина 35. */
const PANEL_R = 231 / FRAME_W;
const PANEL_W = 35 / FRAME_W;

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

/* Спалах щойно засвіченого сегмента: 1.0 -> 1.12 -> 1.0 за 250 мс.
   Пульсацію «дихання» всіх сегментів прибрано разом із рубінами: сім
   паличок, що дихають одночасно, читались як миготіння екрана. */
const PIP_FLASH_SEC = 0.25;
const PIP_FLASH_SCALE = 0.12;
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

  /* Коли саме сталась подія, за годинником малювання (t у drawPips).
     Тримаємо ТУТ, а не в презентері, бо це чиста анімація й нікому
     більше не потрібна: презентер віддає лише СТАН (got/need/justLit),
     а скільки триває спалах і хвиля — справа самого кільця.
     -1 — події ще не було. */
  private doneAt = -1;
  private litIdx = -1;
  private litAt = -1;

  /* Скільки сегментів реально показуємо. Панелей на кільці рівно сім,
     тому якщо CONFIG.pity колись стане іншим, більше семи ми все одно
     не намалюємо (а менше — намалюємо стільки, скільки треба). */
  private segsFor(need: number): readonly PipSeg[] {
    return SEGMENTS.slice(0, Math.max(0, Math.min(SEGMENTS.length, need)));
  }

  /* ПАЛИЧКИ ПРОГРЕСУ. Малюються ПОВЕРХ кільця, тому окремим методом:
     всередині draw() вони лягли б під саме зображення кільця, а
     заглиблена панель непрозора — під нею їх не було б видно взагалі.

     got — пустих ставок поспіль, need — поріг гарантії (CONFIG.pity).
     t — час у секундах (реальний, не прискорений).
     justLit — індекс сегмента, що загорівся щойно (-1, якщо ні). */
  drawPips(
    ctx: Ctx, cx: number, cy: number, frameW: number, frameH: number,
    got: number, need: number, t: number, justLit = -1,
  ): void {
    const segs = this.segsFor(need);
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

    // скільки сегментів уже позеленіло (хвиля по черзі, за годинниковою)
    const greenN = done
      ? Math.min(segs.length, Math.floor((t - this.doneAt) / PIP_WAVE_SEC) + 1)
      : 0;

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const on = done || i < got;

      if (!on) {
        /* Порожній сегмент трохи притемнюємо — інакше «є» й «немає» не
           відрізнити: сама панель темна й без палички. Дуга по смузі
           панелі, а не прямокутник: вона й окреслює сегмент. */
        const a = (seg.deg * Math.PI) / 180;
        const half = ((seg.span - 5) * Math.PI) / 360;
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,.25)';
        ctx.lineWidth = frameW * PANEL_W;
        ctx.beginPath();
        ctx.arc(winCx, winCy, frameW * PANEL_R, a - half, a + half);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const green = i < greenN;
      const art = green ? seg.green : seg.red;
      /* Кожна картинка вже намальована під СВІЙ сегмент — ані повороту,
         ані дзеркалення тут немає й бути не має. */
      const img = art.tint ? Assets.tint(art.key, art.tint) : Assets.get(art.key);

      const flash = this.litIdx === i && this.litAt >= 0
        ? Math.max(0, 1 - (t - this.litAt) / PIP_FLASH_SEC)
        : 0;
      // 1 -> 1.12 -> 1: половина синуса за час спалаху
      const k = 1 + PIP_FLASH_SCALE * Math.sin(flash * Math.PI);

      const w = frameW * art.w, h = frameH * art.h;
      const px = x0 + frameW * art.x, py = y0 + frameH * art.y;
      // спалах «дихає» від ЦЕНТРУ палички, а не від кута прямокутника
      const dw = w * k, dh = h * k;
      const dx = px - (dw - w) / 2, dy = py - (dh - h) / 2;

      ctx.save();
      if (img) {
        ctx.drawImage(img, dx, dy, dw, dh);
      } else {
        // картинки немає — кольорова дуга, щоб прогрес усе одно читався
        const a = (seg.deg * Math.PI) / 180;
        const half = ((seg.span - 5) * Math.PI) / 360;
        ctx.strokeStyle = green ? PIP_GREEN : PIP_RED;
        ctx.lineWidth = frameW * PANEL_W;
        ctx.beginPath();
        ctx.arc(winCx, winCy, frameW * PANEL_R, a - half, a + half);
        ctx.stroke();
      }

      /* Світіння спалаху — ДОДАВАННЯМ поверх палички, а не її
         прозорістю: паличка мусить лишатись непрозорою, інакше в
         «темній» фазі з-під неї проступала б панель. Обрізаємо
         світіння самою паличкою (drawImage у режимі 'lighter' по її ж
         силуету), щоб воно не світило по прямокутнику. */
      if (flash > 0 && img) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.55 * flash;
        const glow = Assets.tint(art.key, green ? PIP_GREEN : PIP_RED);
        if (glow) ctx.drawImage(glow, dx, dy, dw, dh);
      }
      ctx.restore();
    }
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
    // центр і радіус вирізу в екранних пікселях
    const winCx = frameX + frameW * FRAME_WIN_CX;
    const winCy = frameY + frameH * FRAME_WIN_CY;
    const winR = frameW * FRAME_WIN_R;

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

    /* Саме кільце — ПОВЕРХ стрічки, прозорий центр показує її знизу.
       Зелені стрілки лінії виплати вже намальовані ВСЕРЕДИНІ цієї
       картинки (зверху й знизу вирізу), тому окремо покажчик не
       малюємо.

       Файл не завантажився — запасний варіант, стара процедурна рама. */
    const img = Assets.get('reelRing');
    if (img) ctx.drawImage(img, frameX, frameY, frameW, frameH);
    else Render.wood(ctx, x - 18, y - 18, itemW + 36, winH + 36);

    ctx.restore();
  }
}
