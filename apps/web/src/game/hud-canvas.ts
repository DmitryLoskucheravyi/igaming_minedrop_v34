/* ============================================================
   HUD НА КАНВАСІ — усе, що малюється поверх шахти.

   Історія ставок, живий лог виграшу, сумарний виграш забігу,
   скаттери, вікно множника, заставка бонуски й панель результату.
   До самої гри вони не мають стосунку: жодна з цих функцій нічого не
   вирішує й нічого не змінює — тільки показує вже пораховане.

   Раніше це були дев'ять методів презентера, і залежності в них були
   невидимі: кожен тягнув `this.` і читав будь-яке з шести десятків
   полів. Тепер параметри стоять у підписі — видно, що саме потрібно
   кожному напису, і жоден із них не може ненароком змінити стан гри.

   Розмір поля, зсув під стрічку історії й форматування грошей однакові
   для всіх, тому їдуть одним контекстом (HudCtx), а не сімома
   аргументами в кожен виклик.
   ============================================================ */

import {
  CONFIG, MULT_WINDOW_SEC, type Run, type RoundResult,
} from '@minedrop/engine';
import { Assets } from './assets';
import { Render, type ReelItem } from './render';
import { TOAST_LIFE, type Toast } from './effects';

/* Скільки тримати заставку «БОНУС ГЕЙМ» перед безкоштовним раундом.
   Достатньо, щоб прочитати, і мало, щоб не заважати другому підряд
   (ретригер трапляється). Презентер бере це число звідси ж — воно й
   керує тривалістю, і малює анімацію згасання. */
export const BONUS_INTRO_SEC = 1.9;

/* Рядок стрічки останніх ставок. item — кірка, що випала (null —
   «пусто»), win/cost — у рублях, x — множник раунду. */
export interface HistoryEntry {
  item: ReelItem;
  win: number;
  cost: number;
  x: number;
}

/* Розмір поля, зсув під стрічку історії й форматування грошей однакові
   для всіх написів HUD, тому їдуть одним контекстом, а не сімома
   аргументами в кожен виклик. */
export interface HudCtx {
  ctx: CanvasRenderingContext2D;
  /** розмір полотна в css-пікселях */
  w: number;
  h: number;
  /* Наскільки вниз посунути верхній HUD: на телефоні верхню смугу
     займає стрічка історії, і без цього зсуву написи лягали б один на
     одного. */
  topInset: number;
  /** намалювати суму в поточній валюті гравця зі значком */
  money: MoneyPainter;
  /* Те саме число, але РЯДКОМ і без значка — коли напис треба спершу
     заміряти, а вже потім вирішити, куди його ставити (табличка
     результату центрує слово WIN і суму однією групою). */
  moneyStr: (rub: number, whole?: boolean) => string;
  /** код валюти гравця і чи її значок одноколірний (тонується в текст) */
  currency: string;
  monoCurrency: boolean;
}

/* Малює суму в поточній валюті гравця зі значком. Полотно брати не
   треба — воно вже в контексті; сюди приходить тільки що і де писати. */
export type MoneyPainter = (
  rub: number, x: number, y: number,
  font: string, color: string, align?: CanvasTextAlign, prefix?: string, whole?: boolean,
) => void;

export function drawHistory(c: HudCtx, history: readonly HistoryEntry[]): void {
  if (!history.length) return;
  if (c.w < 720) { drawHistoryStrip(c, history); return; }

  const w = 156, rh = 34, x = 14, y = 86;
  const n = Math.min(history.length, Math.max(2, Math.floor((c.h - y - 30) / rh) - 1));

  Render.panel(c.ctx, x, y, w, 26 + n * rh, '#2c323b', 4);
  Render.text(c.ctx, 'ПОСЛЕДНИЕ', x + w / 2, y + 18, '700 12px ui-monospace, monospace', '#b9c2ce');

  for (let i = 0; i < n; i++) {
    const e = history[i];
    const ry = y + 26 + i * rh;
    const won = e.win >= e.cost;
    Render.inset(c.ctx, x + 6, ry + 2, w - 12, rh - 5,
      i === 0 ? '#1f2a22' : '#1b1f26', 3);

    if (!e.item) Render.cross(c.ctx, x + 24, ry + rh / 2, 13, 0.85);
    else Render.pickaxe(c.ctx, x + 24, ry + rh / 2, 27, e.item, -0.5);

    Render.text(c.ctx, 'x' + e.x.toFixed(2), x + w - 12, ry + rh / 2 + 5,
      '700 14px ui-monospace, monospace',
      e.win === 0 ? '#7a8595' : (won ? '#5ce08a' : '#e0925c'), 'right');
  }
}

/* Раунд розігрується на полі. Ті самі стани, за якими GameClient
   ховає нижню панель кнопок (див. PLAYING_STATES там і
   .controls.playing у globals.css). */

export function drawHistoryStrip(c: HudCtx, history: readonly HistoryEntry[]): void {
  const cellW = 30, gap = 4, y = 8, h = 30;
  const room = Math.floor((c.w * 0.62 + gap) / (cellW + gap));
  const n = Math.max(0, Math.min(history.length, room, 6));

  for (let i = 0; i < n; i++) {
    const e = history[i];
    const x = 10 + i * (cellW + gap);
    const won = e.win >= e.cost;

    c.ctx.globalAlpha = i === 0 ? 1 : 0.72;
    Render.inset(c.ctx, x, y, cellW, h, i === 0 ? '#1f2a22' : '#1b1f26', 3);
    if (!e.item) Render.cross(c.ctx, x + cellW / 2, y + h * 0.4, 11, 0.85);
    else Render.pickaxe(c.ctx, x + cellW / 2, y + h * 0.4, 22, e.item, -0.5);

    Render.text(c.ctx, 'x' + e.x.toFixed(1), x + cellW / 2, y + h - 4,
      '700 9px ui-monospace, monospace',
      e.win === 0 ? '#7a8595' : (won ? '#5ce08a' : '#e0925c'));
  }
  c.ctx.globalAlpha = 1;
}

/* Живий лог виграшу — push-тости знизу екрана, без фону: рядок
   з'являється легким свайпом угору знизу, тримається і так само
   зникає свайпом угору й розчиненням (не миготить, не займає місце
   постійною табличкою). Новіші — ближче до самого низу. */

export function drawLiveLog(c: HudCtx, toasts: readonly Toast[], playing: boolean): void {
  const n = toasts.length;
  if (!n) return;
  const rowH = 24;
  /* Поки триває розіграш, нижня панель кнопок з'їжджає вниз (клас
     .controls.playing у globals.css) — заради цього логу її й ховають,
     тож використовуємо звільнене місце й опускаємось ближче до краю.
     Поза розіграшем панель на місці, і лог тримається вище за неї. */
  const baseY = c.h - (playing ? 44 : 86);

  for (let i = 0; i < n; i++) {
    const t = toasts[i];
    const rowFromBottom = n - 1 - i;
    const progress = 1 - t.life / TOAST_LIFE;

    let alpha: number, slide: number;
    if (progress < 0.15) {                       // виїзд знизу вгору
      const k = progress / 0.15;
      alpha = k; slide = (1 - k) * 18;
    } else if (progress < 0.7) {                  // тримається на місці
      alpha = 1; slide = 0;
    } else {                                      // зникає тим самим свайпом угору
      const k = (progress - 0.7) / 0.3;
      alpha = 1 - k; slide = -k * 22;
    }

    c.ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    const y = baseY - rowFromBottom * rowH + slide;
    const font = '800 13px ui-monospace, monospace';
    if (t.money != null) {
      c.money(t.money, c.w / 2, y, font, t.color, 'center', t.text + ' +');
    } else {
      Render.text(c.ctx, t.text, c.w / 2, y, font, t.color);
    }
  }
  c.ctx.globalAlpha = 1;
}

/* Сумарний виграш поточного забігу — постійний напис зверху по
   центру, просто текстом (без фону). Живе, доки триває копання. */

export function drawRunningTotal(c: HudCtx, run: Run | null, runBet: number, running: boolean): void {
  if (!run || !running) return;
  const cash = run.collected * runBet / CONFIG.payoutK;
  if (cash <= 0) return;   // "+0" на весь екран нічого не каже — просто мовчимо, доки нема чого показати
  c.money(cash, c.w / 2, 46 + c.topInset,
    '800 20px ui-monospace, monospace', '#ffd34d');
}

/* Скаттери поточного забігу — три зірки в ряд під сумою.

   Порожні кружки показуємо з ПЕРШОГО ж зібраного, а не завжди: доки
   жодного немає, рядок був би постійним шумом на екрані. А от щойно
   один упав — гравцю треба бачити, скільки лишилось. */

export function drawScatters(c: HudCtx, scatters: number, running: boolean): void {
  if (!running || scatters <= 0) return;
  const need = CONFIG.scatter.need;
  const got = Math.min(scatters, need);
  const y = 106 + c.topInset;
  const star = '★'.repeat(got) + '☆'.repeat(Math.max(0, need - got));
  Render.text(c.ctx, star + '  ' + got + '/' + need, c.w / 2, y,
    '800 16px ui-monospace, monospace', got >= need ? '#ff9a3c' : '#ffc27a');
}

/* Заставка перед безкоштовною бонускою.

   Не косметика: раунд списав нуль, кірка взялась нізвідки й шахта
   інша — без пояснення це читається як збій. Тому вона й затемнює
   поле, а не висить збоку. */

export function drawBonusIntro(c: HudCtx, bonusIntro: number): void {
  const t = bonusIntro;
  // згасання на останній третині секунди — щоб перехід не був різкий
  const a = Math.min(1, t * 3);
  c.ctx.save();
  c.ctx.globalAlpha = a;
  c.ctx.fillStyle = 'rgba(4,6,9,.78)';
  c.ctx.fillRect(0, 0, c.w, c.h);

  const cy = c.h / 2;
  const pop = Math.max(1, 1.5 - (BONUS_INTRO_SEC - t) * 3);
  const size = Math.round(Math.min(c.w * 0.13, 52) * pop);
  Render.text(c.ctx, 'БОНУС ГЕЙМ', c.w / 2, cy - 6,
    '900 ' + size + 'px ui-monospace, monospace', '#ff9a3c');
  Render.text(c.ctx, '★ ★ ★', c.w / 2, cy - 58,
    '800 22px ui-monospace, monospace', '#ffc27a');
  Render.text(c.ctx, 'три скаттера — раунд за счёт заведения',
    c.w / 2, cy + 34, '700 13px ui-monospace, monospace', '#c8d0da');
  c.ctx.restore();
}

/* Вікно множника: поки воно активне (run.multWindowT > 0), усе зібране
   множиться на run.multActive. Показуємо великий "X{n}" і смужку часу,
   що спадає, — під сумарним виграшем. Пульсує, коли лишається < 4с. */

export function drawMultWindow(c: HudCtx, run: Run | null, running: boolean): void {
  if (!run || !running || run.multActive <= 1) return;
  /* У бонусці множники стакаються назавжди — вікна немає, і перевірка
     multWindowT там завжди хибна. Без цієї гілки індикатор у бонусці
     не з'являвся б узагалі, хоча множник саме там і найбільший. */
  if (!run.multPermanent && run.multWindowT <= 0) return;

  const y = 78 + c.topInset;

  if (run.multPermanent) {
    Render.text(c.ctx, 'X' + Math.round(run.multActive), c.w / 2, y,
      '800 24px ui-monospace, monospace', '#ffd34d');
    Render.text(c.ctx, 'ДО КОНЦА ЗАБЕГА', c.w / 2, y + 16,
      '700 10px ui-monospace, monospace', '#b08a2a');
    return;
  }

  const frac = Math.max(0, Math.min(1, run.multWindowT / MULT_WINDOW_SEC));
  const secs = Math.max(1, Math.ceil(run.multWindowT));
  const urgent = run.multWindowT < 4;
  const blink = urgent && Math.floor(run.time * 6) % 2 === 0;
  const color = blink ? '#fff2b0' : '#ffd34d';

  Render.text(c.ctx, 'X' + run.multActive + '   ' + secs + ' с', c.w / 2, y,
    '800 22px ui-monospace, monospace', color);

  // смужка часу, що спадає
  const bw = Math.min(220, c.w - 80);
  const bx = (c.w - bw) / 2;
  const by = y + 8;
  c.ctx.fillStyle = 'rgba(0,0,0,.5)';
  c.ctx.fillRect(bx - 2, by - 2, bw + 4, 8);
  c.ctx.fillStyle = color;
  c.ctx.fillRect(bx, by, bw * frac, 4);
}

/* ============================================================
   ТАБЛИЧКА РЕЗУЛЬТАТУ

   Уся вона — це намальована кам'яна рамка (ui/win-banner.png) і те,
   що лежить у її заглибленому полі: слово WIN картинкою
   (ui/win-word.png) і сума виграшу у валюті гравця. Більше нічого:
   ні темної панелі під ними, ні ставки, ні назви кірки, ні плашки
   BIG WIN, ні підказки «клік — далі».

   Раніше тут була модалка Render.panel із чотирма рядками тексту, а
   рамка сідала їй на верхній край. Тепер рамка Є вікном результату —
   другої рамки навколо неї малювати нема за чим.

   Обидві картинки намальовані ВЕРТИКАЛЬНО (139x560 і 86x166) і лежать
   боком — повертає їх Assets.rotCCW, рівно один раз за сесію, а не
   щокадру. Пропорції нижче — уже від ПОВЕРНУТИХ розмірів.
   ============================================================ */
const BANNER_ASPECT = 139 / 560;
const WORD_ASPECT = 86 / 166;

/* Заглиблене поле таблички — заміряно з ПОВЕРНУТОЇ картинки (560x139)
   по однорідній заливці: x 28..537, y 46..115. Верхній борт товщий за
   нижній (зверху на рамці лежить листя), тому поле НЕ по центру
   картинки — і саме тому його координати заміряні, а не виведені з
   симетрії. */
const BANNER_IN_X0 = 28 / 560;
const BANNER_IN_X1 = 537 / 560;
const BANNER_IN_Y0 = 46 / 139;
const BANNER_IN_Y1 = 115 / 139;

/** ширина таблички: частка кадру, але не ширша за це */
const BANNER_MAX_W = 460;
/** висота слова WIN і цифр — у частках висоти заглибленого поля */
const WORD_FILL = 0.80;
const SUM_FILL = 0.66;
/** проміжок між словом і сумою, у частках висоти поля */
const GROUP_GAP = 0.26;

export function drawResult(c: HudCtx, round: RoundResult | null, resultT: number): void {
  if (!round) return;
  const banner = Assets.rotCCW('winBanner');
  if (!banner) return;

  const ctx = c.ctx;
  const bw = Math.min(c.w - 32, BANNER_MAX_W);
  const bh = bw * BANNER_ASPECT;
  const cx = c.w / 2, cy = c.h / 2;

  /* Коротке «наїзд» табличкою. Плашки BIG WIN більше немає, і без
     цього руху результат просто з'являвся б готовим ярликом. */
  const pop = 1 + Math.max(0, 0.08 - resultT * 0.32);

  ctx.save();
  ctx.globalAlpha = Math.min(1, resultT * 3);
  ctx.translate(cx, cy);
  ctx.scale(pop, pop);
  ctx.translate(-cx, -cy);

  ctx.drawImage(banner, cx - bw / 2, cy - bh / 2, bw, bh);

  // заглиблене поле в екранних пікселях
  const ix = cx - bw / 2 + bw * BANNER_IN_X0;
  const iw = bw * (BANNER_IN_X1 - BANNER_IN_X0);
  const iy = cy - bh / 2 + bh * BANNER_IN_Y0;
  const ih = bh * (BANNER_IN_Y1 - BANNER_IN_Y0);
  const icy = iy + ih / 2;

  const word = Assets.rotCCW('winWord');
  const sum = c.moneyStr(round.payout, true);

  /* Спершу ЗАМІРЯЄМО обидві частини, потім ставимо їх однією групою по
     центру поля. Довга сума (шестизначна на великій ставці) інакше
     вилізла б за рамку. */
  let wordH = ih * WORD_FILL;
  let sumH = ih * SUM_FILL;
  const gap = ih * GROUP_GAP;
  let wordW = word ? wordH / WORD_ASPECT : 0;
  let sumW = Render.pixelMoneyWidth(sum, sumH, c.currency, c.monoCurrency, '#fff2b0');

  if (sumW < 0) {
    /* Растровий шрифт не набрав рядок (немає листа або дивний символ
       у форматі валюти) — сума йде системним шрифтом, слово WIN
       лишається картинкою. */
    const font = '800 ' + Math.round(ih * 0.72) + 'px ui-monospace, monospace';
    c.money(round.payout, cx, icy + ih * 0.28, font, '#fff2b0', 'center', '', true);
    ctx.restore();
    return;
  }

  /* Усе масштабується лінійно від висоти, тож досить одного множника
     на всю групу. */
  const wordGap = word ? gap : 0;
  const total = wordW + wordGap + sumW;
  const k = total > iw ? iw / total : 1;
  wordH *= k; sumH *= k; wordW *= k; sumW *= k;

  let x = cx - (total * k) / 2;
  if (word) {
    ctx.drawImage(word, x, icy - wordH / 2, wordW, wordH);
    x += wordW + wordGap * k;
  }
  // базова лінія цифр — так, щоб вони стояли по центру поля
  Render.pixelMoney(ctx, sum, x, icy + sumH / 2, sumH, '#fff2b0',
    c.currency, c.monoCurrency, 'left');

  ctx.restore();
}
