/* ============================================================
   PRESENTER — стани, камера, ввід, рендер.

   ЧИМ ЦЕ ВІДРІЗНЯЄТЬСЯ ВІД СТАРОЇ ВЕРСІЇ
   Раніше цей файл САМ вирішував, що випало, скільки нарахувати і
   коли дати бонуску. Тепер він не вирішує нічого: натиснули кнопку ->
   пішов запит -> сервер повернув РАУНД ЦІЛКОМ (сид, прокрути, кірки,
   виплату, новий баланс). Далі презентер лише програє це в часі.

   Політ не передається по мережі — він відтворюється з сида тим
   самим рушієм. Наприкінці забігу клієнт звіряє свою суму з
   серверною: збіглось — усе чесно й детерміновано; ні — правий
   сервер, а в UI зʼявляється попередження (це баг, а не «везіння»).

   IDLE -> SPIN -> RISE -> RUNNING -> DROPDONE -> RESULT -> IDLE
   ============================================================ */

import {
  BLOCKS, CONFIG, Mine, MULT_WINDOW_SEC, Run, SIM_DT, TIER_BY_ID, buildSetup, createRun, streamRoot,
  type RoundResult, type RoundSetup, type Tier,
} from '@minedrop/engine';
import { Api, ApiError, type PlayerState } from '../lib/api';
import {
  CURRENCY_META, FALLBACK_RATES, fmtAmount, fmtWhole,
  type CurrencyCode, type Rates,
} from '../lib/currency';
import { haptic, setupMiniApp } from '../lib/telegram';
import { Assets } from './assets';
import { FRAME_ASPECT, FRAME_INNER_BOTTOM, FRAME_INNER_LEFT, FRAME_INNER_RIGHT, FRAME_INNER_TOP, Reel } from './reel';
import { Render, type ReelItem } from './render';

const roundKey = () =>
  globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(36).slice(2);

type State = 'LOADING' | 'IDLE' | 'SPIN' | 'RISE' | 'RUNNING' | 'DROPDONE' | 'RESULT' | 'ERROR';

export interface HudState {
  state: State;
  /** сирий баланс у рублях (базова одиниця) — DOM форматує сам під вибрану валюту */
  balance: number;
  bet: number;
  bets: number[];
  message: string;
  canSpin: boolean;
  /** pity: пустих ставок поспіль і поріг, на якому кірка гарантована */
  dryStreak: number;
  pityAt: number;
  /** курс валют із серверного config (для DOM-форматування) */
  rates: Rates;
  busy: boolean;
  /** RESULT без жодного виграшу (кірка не випала або нічого не зловила) —
      показувати модалку "+0" нема сенсу, HUD сам скаже коротко в статусі. */
  resultEmpty: boolean;
  /** null — ще не перевіряли; true — клієнт зійшовся з сервером */
  verified: boolean | null;
  /** прискорення програвання раунду: 1 | 2 | 3 | 4 */
  speed: number;
  /** автоплей: раунди йдуть один за одним, поки вистачає балансу */
  autoplay: boolean;
  fair: { serverSeedHash: string; clientSeed: string; nonce: number } | null;
  error: string | null;
  /** профіль гравця з телеграма: імʼя і @нік (або ID, якщо ніка нема).
      null — стан гравця ще не приїхав із сервера. */
  profile: { name: string; handle: string } | null;
}

interface HistoryEntry {
  item: ReelItem;
  win: number;
  cost: number;
  x: number;
}

interface Particle { x: number; y: number; vx: number; vy: number; size: number; life: number; color: string }
/* money — сума в рублях: рядок будується на льоту під поточну валюту й
   малюється Render.money зі значком. prefix — текст перед сумою ('+', 'БУМ! +').
   Якщо money не задано — показуємо просто text. */
interface Popup { x: number; y: number; life: number; text: string; color: string; size: number; money?: number; prefix?: string }

const MAX_TICKS_PER_FRAME = 8;   // щоб просадка кадрів не перетворилась на спіраль
const RESULT_GRACE = 0.4;        // мін. затримка перед тим, як клік/пробіл по RESULT щось робить
const SPEEDS = [1, 2, 3, 4];     // прискорення програвання раунду (кнопка »)
const AUTOPLAY_HOLD = 0.9;       // скільки показувати результат перед авто-наступним раундом
const TOAST_LIFE = 1.6;          // скільки секунд живе один push-тост живого логу
const TOAST_MAX = 3;             // скільки тостів одночасно на екрані (старіші зникають)
/* Огорожа — рівно ОДИН шар блоків за кожним краєм поля. Далі нічого:
   чорний фон, який уже залив drawSky(). Огорожа суто декоративна —
   у фізиці межа шахти є завжди, незалежно від того, що намальовано. */
const FENCE_COLS = 1;

/* ---- освітлення навколо кірки ----
   Зона, у якій кірка зараз працює, лишається такою ж яскравою, як була;
   усе, що далі за DIM_NEAR клітинок від будь-якої кірки, гасне до
   DIM_MAX. Перехід розтягнутий на DIM_FADE клітинок — різка межа
   читалась би як круглий ліхтарик, а не як природний спад світла. */
const DIM_NEAR = 2;      // радіус повністю освітленої зони, у клітинках
const DIM_FADE = 1.6;    // на скількох клітинках світло згасає
const DIM_MAX = 0.28;    // наскільки темнішає найдальше (0.28 ≈ 28%)

/* ---- зум пальцями ----
   Межі задані в частках CONFIG.viewCols. ZOOM_MIN 0.44 при viewCols 9.6
   дає ~22 колонки в кадрі — усе поле з огорожею й запасом чорноти
   навколо; ZOOM_MAX 2.4 — близько 4 колонок, коли хочеться роздивитись
   блоки впритул. Фактичний розмір клітинки додатково обмежують
   CONFIG.minCell / maxCell. */
const ZOOM_MIN = 0.44;
const ZOOM_MAX = 2.4;

/* ---- ручне гортання поля ----
   Один палець тягне кадр по вертикалі: гравець може відвести погляд і
   роздивитись шахту, поки кірка працює. Щойно він припиняє гортати,
   камера сама повертається до кірки — PAN_HOLD секунд «не чіпай».
   Час рахується РЕАЛЬНИЙ, а не прискорений: на швидкості ×4 пауза має
   лишатись тими самими п'ятьма секундами. */
const PAN_HOLD = 5;       // секунд спокою до повернення фокуса на кірку
const PAN_MIN_PX = 6;     // менший рух — це тап, а не гортання
const PAN_LIMIT = 50;     // на скільки рядів можна відійти від кірки

/* ---- плашки великого виграшу ----
   Пороги в іксах від ставки. Прив'язані до реального розподілу виплат
   (sim:final): x5 ≈ верхні 5% раундів, x15 ≈ 1%, x40 ≈ 0.1%. Тобто
   «BIG WIN» справді рідкісний, а не з'являється через раз — інакше
   плашка нічого не означає. Береться найвищий досягнутий поріг. */
const WIN_TIERS: readonly { at: number; text: string; color: string }[] = [
  { at: 5, text: 'BIG WIN', color: '#5ce08a' },
  { at: 15, text: 'MEGA WIN', color: '#ffd34d' },
  { at: 40, text: 'EPIC WIN', color: '#ff9a3c' },
  { at: 100, text: 'JACKPOT', color: '#ff6ad5' },
];

function winTier(x: number): { text: string; color: string } | null {
  let hit: { text: string; color: string } | null = null;
  for (const t of WIN_TIERS) if (x >= t.at) hit = t;
  return hit;
}

export class Presenter {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private reel = new Reel();
  private raf = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  private state: State = 'LOADING';
  private message = 'загрузка…';
  private error: string | null = null;
  private busy = false;
  private resultEmpty = false;
  private verified: boolean | null = null;

  /* серверний стан, показуємо як є */
  private player: PlayerState | null = null;
  private balance = 0;
  private bet = 50;

  /* валюта відображення (косметика): база — рублі, гравець може
     перемкнути на USDT/зірки. Курс приходить у config.rates. */
  private currency: CurrencyCode = 'RUB';
  private rates: Rates = FALLBACK_RATES;

  /* прискорення програвання (косметика — фізика лишається фіксованим
     кроком SIM_DT, просто за кадр проганяємо більше кроків) і автоплей */
  private speed = 1;
  private autoplay = false;

  /* поточний раунд */
  private round: RoundResult | null = null;
  private setup: RoundSetup | null = null;
  private mine: Mine | null = null;
  private run: Run | null = null;
  private tier: Tier | null = null;
  private spinIndex = 0;
  private shown: ReelItem[] = [];
  private history: HistoryEntry[] = [];

  /* подача */
  private stage = 0;
  private stageTarget = 0;
  /* Камера стежить за кіркою по ОБОХ осях і тримає її по центру екрана.
     camX/camY — координата лівого верхнього кута видимої області в
     клітинках. camXIdle/camMin — де стоїть камера, поки забігу немає
     (крутиться рулетка): поле по центру, поверхня внизу екрана. */
  private camX = 0;
  private camXIdle = 0;
  /* Масштаб від жесту двома пальцями. 1 — як у конфізі (viewCols),
     більше — ближче, менше — далі. */
  private zoom = 1;
  /* Скільки ще секунд камера НЕ тягнеться за кіркою: гравець гортає
     поле сам. Тікає реальним часом (див. PAN_HOLD). */
  private panT = 0;
  private camY = 0;
  private camMin = 0;
  private shake = 0;
  private flash = 0;
  private flashColor = '#fff';
  private resultT = 0;
  private timer = 0;
  private timerFn: (() => void) | null = null;
  private acc = 0;
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  /* Живий лог виграшу — push-тости знизу екрана, без фону: рядок
     виїжджає знизу вгору, тримається і зникає таким самим свайпом
     угору. Кожен тост незалежний, life рахується від TOAST_LIFE вниз. */
  private toasts: { text: string; color: string; life: number; money?: number }[] = [];
  /* Поточний множник зачарування — для постійного напису зверху праворуч.
     Оновлюється подіями 'magic'; скидається на новий забіг. */
  private enchantMult = 1;

  /* геометрія */
  private w = 0; private h = 0; private cell = 0;
  private itemW = 0; private itemH = 0;
  private frameW = 0; private frameH = 0;

  private onHud: (h: HudState) => void;
  private onResize = () => this.layout();

  /* Поки на екрані модалка (депозит, чесність, історія платежів) або
     фокус у полі вводу — пробіл належить їм, а не грі. Без цього
     набраний у полі суми пробіл і з'їдався (preventDefault), і
     запускав новий раунд «з-під» відкритого вікна. */
  private typing(target: EventTarget | null): boolean {
    if (typeof document !== 'undefined' && document.querySelector('.modal, .drawer-overlay.open')) {
      return true;
    }
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space') return;
    if (this.typing(e.target)) return;
    e.preventDefault();
    /* Затиснутий пробіл (ще з моменту старту прокруту) генерує браузером
       ПОВТОРНІ keydown з e.repeat=true, доки палець не відпустять.
       Ігноруємо повтори: реагуємо лише на СПРАВЖНє нове натискання. */
    if (e.repeat) return;
    /* Тап/пробіл по самому ПОЛЮ після результату — це лише «подивився,
       закрив», без наміру одразу поставити нову ставку: повертає в
       головний екран (IDLE). Одразу почати новий раунд одним дотиком
       може ЛИШЕ явна кнопка «ГРАТИ» (primary() з GameClient) — див.
       коментар у primary(). */
    if (this.state === 'RESULT') {
      if (this.resultT >= RESULT_GRACE) this.closeResult();
      return;
    }
    this.primary();
  };
  private onClick = () => {
    // під час/одразу після щипка клік не рахуємо — інакше зум пальцями
    // закривав би екран результату
    if (this.pinched) return;
    if (this.state === 'RESULT' && this.resultT >= RESULT_GRACE) this.closeResult();
  };

  /* ---- ЗУМ ДВОМА ПАЛЬЦЯМИ ----
     Стежимо за активними вказівниками самі, бо потрібна саме ВІДСТАНЬ
     між двома, а готової події для цього немає. Порівнюємо поточну
     відстань із попередньою і множимо масштаб на їхнє відношення —
     виходить природно: розвів пальці вдвічі, наблизив удвічі.

     Тільки масштаб, без панорами: камера й так сама тримає кірку в
     центрі, і ручне зміщення з нею б воювало. */
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private pinched = false;
  /** накопичений рух пальця — щоб відрізнити тап від гортання */
  private dragged = 0;

  private pointerSpread(): number {
    const pts = [...this.pointers.values()];
    return pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragged = 0;
    if (this.pointers.size === 2) {
      this.pinchDist = this.pointerSpread();
      this.pinched = true;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dy = e.clientY - prev.y;
    const dx = e.clientX - prev.x;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {
      const d = this.pointerSpread();
      if (this.pinchDist > 0 && d > 0) this.setZoom(this.zoom * (d / this.pinchDist));
      this.pinchDist = d;
      return;
    }

    if (this.pointers.size !== 1) return;

    /* ОДИН палець — гортання поля по вертикалі. Тягнемо кадр «за
       вміст»: палець униз -> світ униз -> камера піднімається, тобто
       camY меншає. Поки триває гортання (і PAN_HOLD секунд після),
       камера за кіркою не тягнеться — див. update(). */
    this.dragged += Math.hypot(dx, dy);
    if (this.dragged < PAN_MIN_PX) return;   // це ще тап, а не жест

    this.pinched = true;                     // клік після гортання не рахуємо
    this.panT = PAN_HOLD;
    this.camY -= dy / this.cell;

    /* Не даємо загубитись: далі PAN_LIMIT рядів від кірки відходити
       нема сенсу, а рендер там уперся б у ряди, давно викинуті
       прунингом (їх довелось би перегенеровувати щокадру). */
    const p = this.run?.picks[0];
    if (p) {
      const lo = p.y - PAN_LIMIT;
      const hi = p.y + PAN_LIMIT;
      if (this.camY < lo) this.camY = lo;
      else if (this.camY > hi) this.camY = hi;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    /* Прапорець тримаємо до повного відпускання: браузер шле click уже
       після того, як пальці зникли, і без цього щипок чи гортання
       гасили б екран результату. */
    if (this.pointers.size === 0 && this.pinched) {
      setTimeout(() => { this.pinched = false; }, 120);
    }
  };

  /** Масштаб у межах ZOOM_MIN..ZOOM_MAX. Публічний — знадобиться, якщо
      колись з'явиться кнопка скидання масштабу. */
  setZoom(z: number): void {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (Math.abs(next - this.zoom) < 0.002) return;
    this.zoom = next;
    this.geometry();
  }

  constructor(canvas: HTMLCanvasElement, onHud: (h: HudState) => void) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d недоступний');
    this.ctx = ctx;
    this.onHud = onHud;
  }

  /* ---------------- життєвий цикл ---------------- */

  async init(): Promise<void> {
    setupMiniApp();          // ready/expand + вимкнути свайп-закриття
    this.layout();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKey);
    this.canvas.addEventListener('click', this.onClick);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerUp);

    /* window 'resize' у телеграм-мініапсі майже не спрацьовує:
       шторка/висота міняється через CSS-змінну --tg-viewport-stable-height
       (виставляє сам telegram-web-app.js), а не через зміну розміру ВІКНА.
       Без цього канвас лишався розмальованим під СТАРИЙ (стартовий,
       часто ще не усталений) розмір, а браузер розтягував/стискав уже
       готову картинку під фактичний CSS-розмір — звідси й «сплюснуте,
       видовжене» зображення на телефоні: internal canvas.width/height
       не збігався з реальним відображеним боксом. ResizeObserver ловить
       будь-яку зміну фактичного розміру канваса, незалежно від причини. */
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.layout());
      this.resizeObserver.observe(this.canvas);
    }

    this.decorativeMine();
    this.loop();

    try {
      await Assets.load();
      const p = await Api.me();
      this.applyPlayer(p);
      this.state = 'IDLE';
      this.message = 'Сделай ставку и крути';
    } catch (e) {
      this.state = 'ERROR';
      this.error = e instanceof Error ? e.message : String(e);
      this.message = 'Сервер недоступен';
    }
    this.emit();
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKey);
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerUp);
    this.resizeObserver?.disconnect();
  }

  private loop = (): void => {
    if (this.disposed) return;
    let last = performance.now();
    const frame = (now: number) => {
      if (this.disposed) return;
      const dt = Math.min(0.04, (now - last) / 1000);
      last = now;
      /* Необроблена помилка десередині update()/draw() раніше зупиняла
         ВЕСЬ requestAnimationFrame-цикл назавжди (виняток летить крізь
         callback, і наступний rAF просто не планується) — гра застигала
         в тому стані, в якому впала, а busy/state лишались не-IDLE
         НАЗАВЖДИ: степер ставки й кнопка «ГРАТИ» виглядали «зламаними»
         без жодного повідомлення про причину. Тепер цикл переживає збій:
         показує помилку і повертає керування в IDLE, замість тихого
         паралічу інтерфейсу. */
      try {
        this.update(dt);
        this.draw();
      } catch (err) {
        console.error('Presenter: помилка в кадрі, відновлюю стан', err);
        this.busy = false;
        this.autoplay = false;
        this.state = 'IDLE';
        this.error = 'Техническая ошибка — обнови страницу, если игра не реагирует';
        this.message = this.error;
        try { this.emit(); } catch { /* не даємо другому збою заглушити відновлення */ }
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  };

  /* ---------------- ввід ---------------- */

  /* Ставку можна міняти ЗАВЖДИ, незалежно від того, що зараз на екрані —
     вона лише готується на НАСТУПНИЙ раунд (цей уже стартував зі своєю
     ставкою на сервері й від зміни this.bet не залежить). Раніше вимагало
     IDLE, тому кнопки +/- «блокувались» одразу після прокруту, поки
     гравець не тисне по полю, щоб повернутись у головний екран — зайвий
     і незрозумілий крок. */
  setBet(b: number): void {
    this.bet = b;
    // зменшив ставку до підйомної — плашка нестачі більше не актуальна
    if (this.error && this.balance >= b) this.error = null;
    // серія до гарантії — своя на кожній ставці; перемалювати прогрес під нову
    this.emit();
  }

  /** Валюта відображення. Косметика: перемальовує суми на канвасі й у HUD,
      на баланс і математику не впливає. */
  setCurrency(c: CurrencyCode): void {
    this.currency = c;
    this.emit();
  }

  /** Наступне прискорення по колу: 1 -> 2 -> 3 -> 4 -> 1.
      Фізика від цього не змінюється (той самий фіксований крок) —
      просто за кадр робимо більше кроків, тож раунд грається швидше. */
  cycleSpeed(): void {
    this.speed = SPEEDS[(SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length];
    this.emit();
  }

  /** Автоплей: після результату сам закриває його й запускає новий
      раунд, доки увімкнено і вистачає балансу. */
  toggleAutoplay(): void {
    this.autoplay = !this.autoplay;
    this.emit();
    if (this.autoplay && this.state === 'IDLE' && !this.busy) {
      if (this.balance >= this.bet) void this.startRound();
      else { this.autoplay = false; this.notEnough(); }
    }
  }

  /* Малює суму (в рублях) поточною валютою зі значком.
     whole=true — велика сума (виплата, ставка): у рублях ціле;
     whole=false — дрібна (виграш за блок): показуємо дріб. */
  private drawMoney(
    ctx: CanvasRenderingContext2D, rub: number, x: number, y: number,
    font: string, color: string, align: CanvasTextAlign = 'center', prefix = '+',
    whole = false,
  ): void {
    const meta = CURRENCY_META[this.currency];
    const s = whole
      ? fmtWhole(rub, this.currency, this.rates)
      : fmtAmount(rub, this.currency, this.rates);
    Render.money(ctx, prefix + s, x, y, font, color, this.currency, meta.mono, align);
  }

  /** ЛИШЕ кнопка «ГРАТИ»: завжди одразу новий раунд — навіть одразу після
      результату попереднього, без окремого проміжного кроку «далі».
      Тап по самому полю чи пробіл після результату так НЕ роблять —
      вони просто закривають результат в IDLE (onClick/onKey нижче),
      щоб випадковий дотик по екрану не ставив нову ставку самовільно.
      Мінімальна затримка (RESULT_GRACE) — щоб залишковий/затриманий клік,
      що прилетів ще з попереднього раунду, не спрацював АВТОМАТИЧНО,
      щойно з'явиться результат. */
  primary(): void {
    if (this.state === 'RESULT') {
      if (this.resultT < RESULT_GRACE) return;
      this.closeResult();
      if (this.balance >= this.bet) void this.startRound();
      else this.notEnough();
      return;
    }
    if (this.state !== 'IDLE' || this.busy) return;
    if (this.balance < this.bet) { this.notEnough(); return; }
    void this.startRound();
  }

  /* Тап «ГРАТИ» при нестачі коштів — червона плашка над полем. */
  private notEnough(): void {
    this.error = 'Недостаточно средств — пополни баланс или уменьши ставку';
    this.message = this.error;
    haptic('lose');
    this.emit();
  }

  /* ---------------- раунд ---------------- */

  private applyPlayer(p: PlayerState): void {
    this.player = p;
    this.balance = p.balance;
    // баланс поповнили / прийшов новий стан — прибираємо плашку нестачі
    if (this.error && this.balance >= this.bet) this.error = null;
    if (p.config?.rates) this.rates = p.config.rates;
    if (p.config?.bets?.length && !p.config.bets.includes(this.bet)) {
      this.bet = p.config.bets[Math.min(2, p.config.bets.length - 1)];
    }
  }

  /** Перечитати стан гравця з сервера.

      Потрібно після того, як гроші змінилися ПОЗА грою: адмін підтвердив
      заявку на депозит або поповнив баланс вручну. Раніше такого шляху не
      було взагалі — вікно депозиту поллило свій ендпоінт, а презентер про
      зарахування не дізнавався, і гравець бачив старий баланс, доки не
      зіграє раунд.

      Баланс підмінюємо тільки коли раунд не йде: під час розіграшу на
      екрані свідомо стоїть «баланс після списання», і замінювати його
      серверним числом посеред анімації не можна. */
  async refreshPlayer(): Promise<void> {
    let p: PlayerState;
    try {
      p = await Api.me();
    } catch {
      return;   // фонове оновлення: не шумимо, спробуємо наступного разу
    }

    this.player = p;
    if (p.config?.rates) this.rates = p.config.rates;

    if (this.state === 'IDLE' || this.state === 'RESULT' || this.state === 'ERROR') {
      this.balance = p.balance;
      if (this.error && this.balance >= this.bet) this.error = null;
      if (this.state === 'ERROR') {
        this.state = 'IDLE';
        this.message = 'Сделай ставку и крути';
      }
    }
    this.emit();
  }

  private async startRound(): Promise<void> {
    this.busy = true;
    this.error = null;
    this.verified = null;
    this.message = 'запрос на сервер…';
    this.emit();

    /* Ключ ідемпотентності живе на всю спробу, включно з ретраєм:
       у вебв'ю телеграма запит може дійти до сервера й обірватись
       на відповіді. З тим самим ключем сервер поверне вже зіграний
       раунд, а не спише ставку вдруге. */
    const key = roundKey();
    let res;
    try {
      res = await Api.play(this.bet, key);
    } catch (e) {
      if (e instanceof ApiError) {
        // сервер відповів і відмовив — ретраїти нема сенсу
        this.busy = false;
        this.autoplay = false;   // не молотимо запитами по колу
        this.error = e.message;
        this.message = e.message;
        this.emit();
        return;
      }
      // мережа впала: одна повторна спроба тим самим ключем
      try {
        res = await Api.play(this.bet, key);
      } catch (e2) {
        this.busy = false;
        this.autoplay = false;
        this.error = e2 instanceof ApiError ? e2.message : 'Сервер не ответил';
        this.message = this.error;
        this.emit();
        return;
      }
    }

    const { round, player } = res;
    this.player = player;
    this.round = round;
    this.busy = false;

    /* Баланс під час раунду: списане вже пішло, виплату покажемо в кінці */
    this.balance = round.balanceBefore - round.cost;

    /* Розбираємо сид САМІ. Якщо сервер прислав спини, яких із цього
       сида не виходить, — це не наша гра, і про це треба сказати вголос. */
    this.setup = buildSetup(round.seed, round.pity);
    if (this.setup.spins.join() !== round.spins.join()
      || this.setup.tiers.join() !== round.tiers.join()
      || this.setup.startCols.join() !== round.startCols.join()) {
      this.verified = false;
      this.setup = { mode: 'bet', spins: round.spins, tiers: round.tiers,
                     startCols: round.startCols, pity: round.pity };
    }

    this.spinIndex = 0;
    this.shown = [];
    this.stageTarget = 0;
    this.resultT = 0;
    this.acc = 0;
    this.newMine(round.seed);
    this.nextSpin();
    this.emit();
  }

  private nextSpin(): void {
    const setup = this.setup!;

    if (this.spinIndex >= setup.spins.length) { this.launch(); return; }

    this.state = 'SPIN';
    this.message = 'Крутим…';
    this.emit();

    const id = setup.spins[this.spinIndex];
    const winner: ReelItem = id ? TIER_BY_ID[id] : null;

    this.reel.start(winner, (item) => {
      this.shown[this.spinIndex] = item;
      if (item) {
        this.flash = 0.25;
        this.flashColor = '#ffd34d';
        // перша ж кірка зупиняє прокрути
        this.tier = item;
        this.message = item.name + '! Пошли копать';
        this.state = 'RISE';
        this.stageTarget = 1;
        this.emit();
        this.wait(CONFIG.reel.riseMs / 1000, () => this.launch());
        return;
      }
      this.message = 'Пусто';
      this.emit();
      this.wait(CONFIG.reel.gapMs / 1000, () => { this.spinIndex++; this.nextSpin(); });
    }, CONFIG.reel.spinMs);
  }

  private launch(): void {
    const round = this.round!;
    const setup = this.setup!;

    if (!setup.tiers.length) {           // кірка не випала — ставка згоріла
      this.finishRound();
      return;
    }

    if (this.state !== 'RISE') {
      this.state = 'RISE';
      this.stageTarget = 1;
      this.message = 'Кирок в шахту: ' + setup.tiers.length;
      this.emit();
      this.wait(CONFIG.reel.riseMs / 1000, () => this.launch());
      return;
    }

    const made = createRun(round.seed, setup);
    if (!made) { this.finishRound(); return; }
    this.mine = made.mine;
    this.run = made.run;
    this.tier = TIER_BY_ID[setup.tiers[0]];
    this.state = 'RUNNING';
    this.message = '';
    this.emit();
  }

  private onRunOver(): void {
    const round = this.round!;
    const run = this.run!;

    /* Головна перевірка: у клієнта мусить вийти те саме, що на сервері */
    const localPayout = run.payout(round.bet);
    if (this.verified !== false) this.verified = localPayout === round.payout;
    if (!this.verified) {
      console.error('Розбіжність із сервером:', {
        seed: round.seed, локально: localPayout, сервер: round.payout,
      });
    }

    this.state = 'DROPDONE';
    this.message = `Глубина ${Math.floor(run.depth)}, блоков ${run.blocks}  →  +${round.payout}`;
    this.emit();
    this.wait(1.1, () => this.finishRound());
  }

  private finishRound(): void {
    const round = this.round!;
    this.balance = round.balanceAfter;

    const first = round.tiers.length ? TIER_BY_ID[round.tiers[0]] : null;
    this.history.unshift({
      item: first,
      win: round.payout,
      cost: round.cost || round.bet,
      x: round.multiplier,
    });
    if (this.history.length > 12) this.history.pop();

    this.state = 'RESULT';
    this.resultT = 0;
    this.resultEmpty = round.payout === 0;
    const net = round.payout - round.cost;
    haptic(net >= 0 ? 'win' : 'lose');
    this.message = net >= 0 ? 'ВЫИГРЫШ +' + net : 'ПРОИГРЫШ ' + net;
    this.emit();
  }

  private closeResult(): void {
    this.round = null;
    this.setup = null;
    this.run = null;
    this.tier = null;
    this.shown = [];
    this.stageTarget = 0;
    this.decorativeMine();
    this.state = 'IDLE';
    /* Червона плашка стосувалась ПОПЕРЕДНЬОЇ спроби (не вистачило
       коштів, обірвалась мережа). Раунд закрито — причини більше
       нема, а раніше вона висіла в IDLE до наступного оновлення
       стану гравця, тобто виглядала як постійна поломка. */
    this.error = null;
    this.message = this.player && this.balance < this.bet
      ? 'Мало монет — уменьши ставку'
      : 'Сделай ставку и крути';
    this.emit();
  }

  /* ---------------- шахта ---------------- */

  private newMine(seed: string): void {
    this.mine = new Mine(CONFIG.cols, streamRoot(seed, 'mine'));
    this.run = null;
    this.particles = [];
    this.popups = [];
    this.toasts = [];
    this.enchantMult = 1;
    this.camY = this.camMin;
    this.camX = this.camXIdle;
  }

  /* Фон під рулеткою. Ні на що не впливає, тому сид довільний. */
  private decorativeMine(): void {
    this.mine = new Mine(CONFIG.cols, (Math.random() * 0x7fffffff) | 0);
    this.run = null;
    this.particles = [];
    this.popups = [];
    this.camY = this.camMin;
    this.camX = this.camXIdle;
  }

  /* ---------------- HUD ---------------- */

  private emit(): void {
    const p = this.player;
    const idle = this.state === 'IDLE' && !this.busy;

    this.onHud({
      state: this.state,
      balance: this.balance,
      bet: this.bet,
      bets: p?.config?.bets ?? [...CONFIG.bets],
      message: this.message,
      // кнопка активна навіть при нестачі коштів — щоб тап показав плашку
      canSpin: idle || this.state === 'RESULT',
      // серія до гарантії рахується окремо на кожній ставці — показуємо ту,
      // що набита саме на поточній вибраній ставці
      dryStreak: p?.dryStreaks?.[this.bet] ?? 0,
      pityAt: p?.pityAt ?? CONFIG.pity,
      rates: this.rates,
      busy: this.busy,
      resultEmpty: this.resultEmpty,
      verified: this.verified,
      speed: this.speed,
      autoplay: this.autoplay,
      fair: this.round?.fair ?? (p ? { serverSeedHash: p.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce } : null),
      error: this.error,
      profile: p
        ? {
            name: p.firstName?.trim() || 'Игрок',
            handle: p.username ? '@' + p.username : 'ID ' + p.telegramId,
          }
        : null,
    });
  }

  private wait(sec: number, fn: () => void): void {
    this.timer = sec;
    this.timerFn = fn;
  }

  /* ---------------- ПОДІЇ ФІЗИКИ ---------------- */

  private drainEvents(): void {
    const r = this.run;
    if (!r) return;
    for (const e of r.events) {
      if (e.t === 'crack') {
        this.burst(e.c + 0.5, e.r + 0.5, BLOCKS[e.id].color, 4, 0.7);
        this.shake = Math.min(10, this.shake + 1.6);
      } else if (e.t === 'break') {
        this.burst(e.c + 0.5, e.r + 0.5, BLOCKS[e.id].color, 12);
        // живий попап показує РЕАЛЬНУ суму (після ставки й payoutK), дробову
        // за потреби — щоб цифри на екрані не брехали і не тонули в нулі
        const cash = e.got * this.bet / CONFIG.payoutK;
        if (cash > 0) {
          this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.0,
            text: '', color: BLOCKS[e.id].color, size: 0.2, money: cash });
          this.pushLog(BLOCKS[e.id].name, BLOCKS[e.id].color, cash);
        }
        this.shake = Math.min(14, this.shake + 3);
      } else if (e.t === 'mult') {
        // блок-множник більше не іксує зібране — відкриває вікно на e.secs
        // секунд, поки воно активне, усе зібране множиться на e.active
        this.burst(e.c + 0.5, e.r + 0.5, '#ffd34d', 44, 2.4);
        this.shake = 22;
        this.flash = 0.45; this.flashColor = '#ffd34d';
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.8,
          text: 'X' + e.active + ' · ' + e.secs + 'с', color: '#ffe98a', size: 0.34 });
        this.pushLog('Множитель X' + e.active + ' на ' + e.secs + 'с', '#ffe98a');
        haptic('hit');
      } else if (e.t === 'tnt') {
        this.burst(e.c + 0.5, e.r + 0.5, '#ff8a2b', 46, 3);
        for (const h of e.hit) this.burst(h.c + 0.5, h.r + 0.5, BLOCKS[h.id].color, 8);
        // e.got — реальна сума (вже з урахуванням зачарування), не
        // перераховуємо з e.hit клієнтом, бо множник зачарування —
        // рантайм-стан кірки, його нема в статичній таблиці BLOCKS
        const cash = e.got * this.bet / CONFIG.payoutK;
        this.shake = Math.min(34, 22 + e.chain * 3);
        this.flash = 0.35; this.flashColor = '#ff7a2b';
        const boom = e.chain > 1 ? 'БУМ X' + e.chain : 'БУМ!';
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.3,
          text: boom, color: '#ff8a2b', size: 0.26,
          money: cash > 0 ? cash : undefined, prefix: boom + ' +' });
        if (cash > 0) this.pushLog(boom, '#ff8a2b', cash);
      } else if (e.t === 'magic') {
        // СТІЛ ЗАЧАРУВАННЯ: 3 фіксовані рівні множника кірки (не підвищує тір)
        this.burst(e.c + 0.5, e.r + 0.5, '#c46bff', 40, 2.2);
        this.shake = 16;
        this.flash = 0.4; this.flashColor = '#c46bff';
        const roman = ['I', 'II', 'III'][e.lvl - 1] ?? String(e.lvl);
        const mtxt = 'X' + e.mult.toFixed(2).replace(/\.?0+$/, '');
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.6,
          text: 'ЗАЧАРОВАНИЕ ' + roman + '  ' + mtxt, color: '#d9a3ff', size: 0.22 });
        this.pushLog('Зачарование ' + roman + ' · ' + mtxt, '#d9a3ff');
        this.enchantMult = e.mult;
      } else if (e.t === 'tntchain') {
        // бонус за довгий ланцюг детонацій — на весь виграш вибуху
        this.shake = 24;
        this.flash = 0.5; this.flashColor = '#ff9a3c';
        const cash = e.extra * this.bet / CONFIG.payoutK;
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.8,
          text: 'TNT CHAIN X' + e.chain, color: '#ffb15a', size: 0.3,
          money: cash > 0 ? cash : undefined,
          prefix: 'TNT CHAIN X' + e.chain + '  +' + Math.round((e.mult - 1) * 100) + '%  +' });
        this.pushLog('TNT CHAIN X' + e.chain + ' · +' + Math.round((e.mult - 1) * 100) + '%',
          '#ffb15a', cash > 0 ? cash : undefined);
        haptic('win');
      } else if (e.t === 'upgrade') {
        /* ВЕРСТАК: підвищення тіру / повний хіл / дохіл на topUp HP
           (Diamond, кожен верстак після першого). */
        this.burst(e.c + 0.5, e.r + 0.5, '#ffb347', 40, 2.2);
        this.shake = 16;
        this.flash = 0.4; this.flashColor = '#ffb347';
        const tierName = (TIER_BY_ID[e.tier]?.name ?? e.tier).toUpperCase();
        const label = e.topUp > 0 ? '+' + e.topUp + ' HP'
          : e.healOnly ? 'ПОЛНЫЙ ХИЛ!'
          : 'ПОВЫШЕНИЕ! ' + tierName;
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.6,
          text: label, color: '#ffe0b3', size: 0.22 });
        this.pushLog(label, '#ffe0b3');
      } else if (e.t === 'grow') {
        // СТРІЛКА ВГОРУ: кірка більшає (разом із радіусом зіткнення й HP)
        this.burst(e.c + 0.5, e.r + 0.5, '#3ad1a0', 46, 2.6);
        this.shake = 20;
        this.flash = 0.45; this.flashColor = '#3ad1a0';
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.7,
          text: 'X' + e.scale + '  ' + e.secs + 'с', color: '#8ff5d5', size: 0.3 });
        this.pushLog(
          e.stacks > 1 ? 'Рост X' + e.scale + ' (' + e.stacks + ' подряд)' : 'Рост X' + e.scale,
          '#8ff5d5');
        haptic('win');
      } else if (e.t === 'rubber') {
        // ГУМА: трамплін — сильний відскок і швидке падіння після нього
        this.burst(e.c + 0.5, e.r + 0.5, '#ff7ec4', 30, 2.2);
        this.shake = Math.max(this.shake, 14);
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.1,
          text: 'ОТСКОК!', color: '#ffb8de', size: 0.24 });
        haptic('hit');
      } else if (e.t === 'pickdead') {
        this.burst(e.x, e.y, '#8a939f', 22, 1.4);
        this.shake = Math.max(this.shake, 12);
      }
    }
    r.events.length = 0;
  }

  private pushLog(text: string, color: string, money?: number): void {
    this.toasts.push({ text, color, life: TOAST_LIFE, money });
    if (this.toasts.length > TOAST_MAX) this.toasts.shift();
  }

  private burst(x: number, y: number, color: string, n: number, power = 1): void {
    if (this.particles.length > 900) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.6 + Math.random() * 3.2) * power;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.5,
        size: 0.05 + Math.random() * 0.09,
        life: 0.4 + Math.random() * 0.6, color,
      });
    }
  }

  /* ---------------- UPDATE ---------------- */

  private update(dtReal: number): void {
    /* Прискорення: множимо крок часу. Усе (рулетка, таймери, фізика,
       партикли, тряска) грається рівно у stepMul разів швидше. На
       детермінізм не впливає — фізичний крок нижче лишається SIM_DT,
       просто за кадр робимо більше кроків (див. maxTicks). */
    const dt = dtReal * this.speed;
    const maxTicks = MAX_TICKS_PER_FRAME * this.speed;

    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer <= 0) {
        const f = this.timerFn;
        this.timerFn = null;
        this.timer = 0;
        f?.();
      }
    }

    this.reel.update(dt);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 55);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 1.6);
    if (this.state === 'RESULT') {
      this.resultT += dt;
      /* Автоплей: подивились на результат AUTOPLAY_HOLD секунд — закрили
         й погнали далі. Не вистачає балансу — автоплей вимикається. */
      if (this.autoplay && this.resultT >= AUTOPLAY_HOLD) {
        this.closeResult();
        if (this.balance >= this.bet) void this.startRound();
        else { this.autoplay = false; this.notEnough(); }
      }
    }

    // перехід «рулетка в центрі» <-> «гра»
    const sp = dt / (CONFIG.reel.riseMs / 1000);
    if (this.stage < this.stageTarget) this.stage = Math.min(this.stageTarget, this.stage + sp);
    else if (this.stage > this.stageTarget) this.stage = Math.max(this.stageTarget, this.stage - sp);

    /* Фізика йде ФІКСОВАНИМ кроком. Кадри бувають різні, крок — ні:
       інакше траєкторія залежала б від фреймрейту й розійшлася з
       серверною. Накопичуємо реальний час і витрачаємо його порціями. */
    if (this.state === 'RUNNING' && this.run) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= SIM_DT && !this.run.over && n < maxTicks) {
        this.acc -= SIM_DT;
        this.run.tick();
        n++;
      }
      if (this.acc > SIM_DT * maxTicks) this.acc = SIM_DT * maxTicks;
      this.drainEvents();
      if (this.run.over) this.onRunOver();
    }

    /* Камера тримає кірку по центру екрана й ходить за нею по обох осях.

       Раніше вона їхала ТІЛЬКИ вниз (`if (target > camY)`) і тільки по
       вертикалі — по суті стеля, що повзе за найглибшою кіркою. Тепер
       кірка відскакує вгору й ходить по всій ширині поля, тому камера
       має за нею встигати в будь-який бік. Обмеження знизу (camMin)
       лишається лише для стану БЕЗ забігу — щоб під рулеткою поверхня
       стояла там само, де й стояла. */
    /* Гравець щойно гортав поле сам — камера не забирає в нього
       керування, доки не мине PAN_HOLD. Час тут РЕАЛЬНИЙ (dtReal), а не
       прискорений: на швидкості ×4 пауза інакше стискалась би до
       секунди з чвертю. Коли час вийшов, звичайний лерп нижче сам
       плавно приведе кадр назад до кірки — окремої анімації не треба. */
    if (this.panT > 0) {
      this.panT = Math.max(0, this.panT - dtReal);
    } else {
      let tx = this.camXIdle;
      let ty = this.camMin;
      if (this.run) {
        const alive = this.run.alive;
        const p = alive.length ? alive[0] : this.run.picks[0];
        if (p) {
          tx = p.x - this.w / this.cell / 2;
          ty = p.y - (this.h * CONFIG.camLead) / this.cell;
        }
      }
      const k = Math.min(1, dt * CONFIG.camLerp);
      this.camX += (tx - this.camX) * k;
      this.camY += (ty - this.camY) * k;
      if (!this.run && this.camY < this.camMin) this.camY = this.camMin;
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vy += 22 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.y -= 0.9 * dt;
      p.life -= dt;
      if (p.life <= 0) this.popups.splice(i, 1);
    }
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      this.toasts[i].life -= dt;
      if (this.toasts[i].life <= 0) this.toasts.splice(i, 1);
    }
  }

  /* ---------------- РОЗКЛАДКА ---------------- */

  private layout(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geometry();
  }

  /* Похідна геометрія: розмір клітинки, межі камери, розміри рулетки.
     Винесено з layout() окремо, бо зум пальцями міняє саме це і НЕ має
     чіпати розмір канваса — перевиставлення canvas.width щокадру
     жесту і чистить полотно, і смикає читання getBoundingClientRect. */
  private geometry(): void {
    /* Розмір клітинки рахується від viewCols, а НЕ від cols: на екран
       навмисно влазить менше колонок, ніж є в полі. Інакше видно все
       поле одразу, і стежити камері нема за чим — вона стоїть на місці.
       Тепер поле ширше за екран, камера панорамує за кіркою, а біля
       країв з'являється огорожа.

       zoom — жест пальцями: більше 1 наближає (менше колонок у кадрі),
       менше 1 віддаляє. */
    const view = CONFIG.viewCols / this.zoom;
    this.cell = Math.max(CONFIG.minCell, Math.min(CONFIG.maxCell, this.w / view));
    // поле по центру, поки забігу немає
    this.camXIdle = (CONFIG.cols - this.w / this.cell) / 2;

    /* Рамка вікна рулетки — растрове зображення (рамка.png) з фіксованим
       співвідношенням сторін, тому розмір комірки-символу тепер похідна
       від розміру РАМКИ, а не навпаки: спершу вписуємо всю рамку в
       доступний простір (за висотою, з обмеженням по ширині), потім
       ділимо її внутрішнє прозоре вікно на R.visible рівних комірок. */
    const R = CONFIG.reel;
    let frameH = Math.max(280, Math.min(560, this.h * 0.86));
    let frameW = frameH * FRAME_ASPECT;
    const maxFrameW = this.w - 16;
    if (frameW > maxFrameW) { frameW = maxFrameW; frameH = frameW / FRAME_ASPECT; }
    this.frameW = frameW;
    this.frameH = frameH;
    this.itemW = frameW * (FRAME_INNER_RIGHT - FRAME_INNER_LEFT);
    this.itemH = (frameH * (FRAME_INNER_BOTTOM - FRAME_INNER_TOP)) / R.visible;

    // найвища точка камери: поки крутиться рулетка, поверхня стоїть низько
    this.camMin = -(this.h * CONFIG.camIdle) / this.cell;
    // під час забігу камера вільна (стежить за кіркою) — підтягуємо її
    // до межі лише в стані спокою, інакше зміна розміру екрана смикала б
    // кадр посеред польоту
    if (!this.run && this.camY < this.camMin) this.camY = this.camMin;
  }

  private sx(x: number): number { return (x - this.camX) * this.cell; }
  private sy(y: number): number { return (y - this.camY) * this.cell; }

  /* ---------------- DRAW ---------------- */

  private draw(): void {
    const ctx = this.ctx;
    Render.pixelate(ctx);
    this.drawSky(ctx);

    ctx.save();
    if (this.shake > 0) ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    this.drawMine(ctx);
    this.drawParticles(ctx);
    this.drawPicks(ctx);
    this.drawPopups(ctx);
    ctx.restore();


    if (this.flash > 0) {
      ctx.globalAlpha = this.flash * 0.5;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalAlpha = 1;
    }

    /* Рулетка стоїть на місці й ЗГАСАЄ (не їде вгору), трохи осідаючи
       вниз — так видно, як переможна кірка випадає з-під її нижнього
       краю прямо на поле. */
    const a = 1 - this.stage;
    if (a > 0.01) {
      ctx.fillStyle = 'rgba(4,6,9,' + (0.62 * a).toFixed(3) + ')';
      ctx.fillRect(0, 0, this.w, this.h);
      const cy = this.h * 0.42 + this.stage * this.itemH * 0.9;
      this.reel.draw(ctx, this.w / 2, cy, this.frameW, this.frameH, this.itemW, this.itemH, Math.min(1, a * 1.7));
    }

    this.drawHistory(ctx);
    this.drawLiveLog(ctx);
    this.drawRunningTotal(ctx);
    this.drawMultWindow(ctx);
    this.drawEnchantMult(ctx);
    if (this.state === 'RESULT' && !this.resultEmpty) this.drawResult(ctx);
  }

  private drawSky(ctx: CanvasRenderingContext2D): void {
    const horizon = this.sy(0);
    const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
    g.addColorStop(0, '#4aa8f0');
    g.addColorStop(1, '#9fd6ff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, Math.max(0, horizon));
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, Math.max(0, horizon), this.w, this.h - Math.max(0, horizon));
  }

  private drawMine(ctx: CanvasRenderingContext2D): void {
    if (!this.mine) return;
    const cell = this.cell;
    const r0 = Math.max(0, Math.floor(this.camY) - 1);
    const r1 = Math.ceil(this.camY + this.h / cell) + 1;
    const c0 = Math.floor(this.camX) - 1;
    const c1 = Math.ceil(this.camX + this.w / cell) + 1;

    /* Джерела світла — живі кірки. Беремо їх один раз на кадр, а не на
       кожну клітинку. Немає забігу — немає й затемнення: під рулеткою
       поле має виглядати так само, як раніше. */
    const lights = this.run ? this.run.alive : [];

    for (let r = r0; r <= r1; r++) {
      const y = this.sy(r);
      for (let c = c0; c <= c1; c++) {
        const x = this.sx(c);
        const dark = this.dimAt(lights, r, c);

        /* За краєм поля — огорожа завширшки FENCE_COLS, далі нічого:
           там лишається чорний фон, який уже залив drawSky(). Огорожа
           не існує в сітці й ні на що не впливає: межа шахти й так є у
           фізиці (Mine.get за краєм повертає WALL), просто досі її не
           було видно — при фіксованій камері край поля збігався з краєм
           екрана. */
        if (c < 0 || c >= CONFIG.cols) {
          if (c >= -FENCE_COLS && c < CONFIG.cols + FENCE_COLS) {
            Render.fence(ctx, x, y, cell);
            Render.shade(ctx, x, y, cell, r);
            Render.dim(ctx, x, y, cell, dark);
          }
          continue;
        }

        /* peek(), а не get(): рендер не має права створювати стан гри.
           get() для ряду, викинутого прунингом, згенерував би його
           наново — ЦІЛИМ — і поклав у кеш, після чого кірка зіткнулася б
           із блоками, яких на сервері вже немає. Тобто клієнт розходився б
           із сервером через саме лише малювання. Див. Mine.peek(). */
        const b = this.mine.peek(r, c);
        if (!b || 'wall' in b) continue;
        Render.block(ctx, x, y, cell, b, r);
        Render.shade(ctx, x, y, cell, r);
        Render.dim(ctx, x, y, cell, dark);
      }
    }
  }

  /* Наскільки затемнити клітинку (r, c): 0 поруч із кіркою, DIM_MAX
     далеко від неї. Рахуємо від НАЙБЛИЖЧОЇ кірки — якщо їх колись стане
     кілька, кожна світить сама за себе. Відстань беремо до центру
     клітинки, тому світло рівномірне навколо кірки, а не квадратне. */
  private dimAt(lights: readonly { x: number; y: number }[], r: number, c: number): number {
    if (!lights.length) return 0;
    let best = Infinity;
    for (const p of lights) {
      const d = Math.hypot(p.x - (c + 0.5), p.y - (r + 0.5));
      if (d < best) best = d;
    }
    if (best <= DIM_NEAR) return 0;
    return DIM_MAX * Math.min(1, (best - DIM_NEAR) / DIM_FADE);
  }

  private drawParticles(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2.2));
      ctx.fillStyle = p.color;
      const s = p.size * this.cell;
      ctx.fillRect(this.sx(p.x), this.sy(p.y), s, s);
    }
    ctx.globalAlpha = 1;
  }

  private drawPicks(ctx: CanvasRenderingContext2D): void {
    if (!this.run) return;
    for (const p of this.run.picks) {
      const x = this.sx(p.x);
      const y = this.sy(p.y);
      // розмір спрайту йде за p.scale — тим самим, що й радіус зіткнення
      const size = this.cell * 1.5 * p.scale;
      if (p.dead) ctx.globalAlpha = 0.25;
      Render.pickaxe(ctx, x, y, size, p.tier, p.rot, p.enchanted);
      ctx.globalAlpha = 1;
      if (!p.dead && this.state === 'RUNNING') {
        // підпис HP тримається над спрайтом, тож теж їде за розміром
        Render.hpLabel(ctx, x, y - size * 0.62, p.hp, p.hpMax, this.cell);
      }
    }
  }

  private drawPopups(ctx: CanvasRenderingContext2D): void {
    for (const p of this.popups) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.4));
      const font = '800 ' + Math.round(this.cell * p.size) + 'px ui-monospace, monospace';
      if (p.money != null) {
        this.drawMoney(ctx, p.money, this.sx(p.x), this.sy(p.y), font, p.color, 'center', p.prefix ?? '+');
      } else {
        Render.text(ctx, p.text, this.sx(p.x), this.sy(p.y), font, p.color);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* Історія ставок. На широкому екрані — колонка зліва; на телефоні
     вона б з'їла пів поля, тому там компактна стрічка зверху зліва.
     Раніше на вузькому екрані історії не було ВЗАГАЛІ — тобто на
     основній платформі гри цей код просто ніколи не виконувався. */
  private drawHistory(ctx: CanvasRenderingContext2D): void {
    if (!this.history.length) return;
    if (this.w < 720) { this.drawHistoryStrip(ctx); return; }

    const w = 156, rh = 34, x = 14, y = 86;
    const n = Math.min(this.history.length, Math.max(2, Math.floor((this.h - y - 30) / rh) - 1));

    Render.panel(ctx, x, y, w, 26 + n * rh, '#2c323b', 4);
    Render.text(ctx, 'ПОСЛЕДНИЕ', x + w / 2, y + 18, '700 12px ui-monospace, monospace', '#b9c2ce');

    for (let i = 0; i < n; i++) {
      const e = this.history[i];
      const ry = y + 26 + i * rh;
      const won = e.win >= e.cost;
      Render.inset(ctx, x + 6, ry + 2, w - 12, rh - 5,
        i === 0 ? '#1f2a22' : '#1b1f26', 3);

      if (!e.item) Render.cross(ctx, x + 24, ry + rh / 2, 13, 0.85);
      else Render.pickaxe(ctx, x + 24, ry + rh / 2, 27, e.item, -0.5, false);

      Render.text(ctx, 'x' + e.x.toFixed(2), x + w - 12, ry + rh / 2 + 5,
        '700 14px ui-monospace, monospace',
        e.win === 0 ? '#7a8595' : (won ? '#5ce08a' : '#e0925c'), 'right');
    }
  }

  /* Раунд розігрується на полі. Ті самі стани, за якими GameClient
     ховає нижню панель кнопок (див. PLAYING_STATES там і
     .controls.playing у globals.css). */
  private get playing(): boolean {
    return this.state === 'SPIN' || this.state === 'RISE'
      || this.state === 'RUNNING' || this.state === 'DROPDONE';
  }

  /* Наскільки вниз посунути верхній HUD (сумарний виграш, вікно
     множника, зачарування): на телефоні верхню смугу займає стрічка
     історії, і без цього зсуву написи лягали б один на одного. */
  private get topInset(): number {
    return this.w < 720 && this.history.length ? 42 : 0;
  }

  /* Мобільна історія: горизонтальна стрічка останніх ставок у лівому
     верхньому куті. Найновіша — ліворуч. */
  private drawHistoryStrip(ctx: CanvasRenderingContext2D): void {
    const cellW = 30, gap = 4, y = 8, h = 30;
    const room = Math.floor((this.w * 0.62 + gap) / (cellW + gap));
    const n = Math.max(0, Math.min(this.history.length, room, 6));

    for (let i = 0; i < n; i++) {
      const e = this.history[i];
      const x = 10 + i * (cellW + gap);
      const won = e.win >= e.cost;

      ctx.globalAlpha = i === 0 ? 1 : 0.72;
      Render.inset(ctx, x, y, cellW, h, i === 0 ? '#1f2a22' : '#1b1f26', 3);
      if (!e.item) Render.cross(ctx, x + cellW / 2, y + h * 0.4, 11, 0.85);
      else Render.pickaxe(ctx, x + cellW / 2, y + h * 0.4, 22, e.item, -0.5, false);

      Render.text(ctx, 'x' + e.x.toFixed(1), x + cellW / 2, y + h - 4,
        '700 9px ui-monospace, monospace',
        e.win === 0 ? '#7a8595' : (won ? '#5ce08a' : '#e0925c'));
    }
    ctx.globalAlpha = 1;
  }

  /* Живий лог виграшу — push-тости знизу екрана, без фону: рядок
     з'являється легким свайпом угору знизу, тримається і так само
     зникає свайпом угору й розчиненням (не миготить, не займає місце
     постійною табличкою). Новіші — ближче до самого низу. */
  private drawLiveLog(ctx: CanvasRenderingContext2D): void {
    const n = this.toasts.length;
    if (!n) return;
    const rowH = 24;
    /* Поки триває розіграш, нижня панель кнопок з'їжджає вниз (клас
       .controls.playing у globals.css) — заради цього логу її й ховають,
       тож використовуємо звільнене місце й опускаємось ближче до краю.
       Поза розіграшем панель на місці, і лог тримається вище за неї. */
    const baseY = this.h - (this.playing ? 44 : 86);

    for (let i = 0; i < n; i++) {
      const t = this.toasts[i];
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

      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      const y = baseY - rowFromBottom * rowH + slide;
      const font = '800 13px ui-monospace, monospace';
      if (t.money != null) {
        this.drawMoney(ctx, t.money, this.w / 2, y, font, t.color, 'center', t.text + ' +');
      } else {
        Render.text(ctx, t.text, this.w / 2, y, font, t.color);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* Сумарний виграш поточного забігу — постійний напис зверху по
     центру, просто текстом (без фону). Живе, доки триває копання. */
  private drawRunningTotal(ctx: CanvasRenderingContext2D): void {
    if (!this.run || this.state !== 'RUNNING') return;
    const cash = this.run.collected * this.bet / CONFIG.payoutK;
    if (cash <= 0) return;   // "+0" на весь екран нічого не каже — просто мовчимо, доки нема чого показати
    this.drawMoney(ctx, cash, this.w / 2, 46 + this.topInset,
      '800 20px ui-monospace, monospace', '#ffd34d');
  }

  /* Вікно множника: поки воно активне (run.multWindowT > 0), усе зібране
     множиться на run.multActive. Показуємо великий "X{n}" і смужку часу,
     що спадає, — під сумарним виграшем. Пульсує, коли лишається < 4с. */
  private drawMultWindow(ctx: CanvasRenderingContext2D): void {
    const run = this.run;
    if (!run || this.state !== 'RUNNING' || run.multWindowT <= 0 || run.multActive <= 1) return;

    const y = 78 + this.topInset;
    const frac = Math.max(0, Math.min(1, run.multWindowT / MULT_WINDOW_SEC));
    const secs = Math.max(1, Math.ceil(run.multWindowT));
    const urgent = run.multWindowT < 4;
    const blink = urgent && Math.floor(run.time * 6) % 2 === 0;
    const color = blink ? '#fff2b0' : '#ffd34d';

    Render.text(ctx, 'X' + run.multActive + '   ' + secs + ' с', this.w / 2, y,
      '800 22px ui-monospace, monospace', color);

    // смужка часу, що спадає
    const bw = Math.min(220, this.w - 80);
    const bx = (this.w - bw) / 2;
    const by = y + 8;
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(bx - 2, by - 2, bw + 4, 8);
    ctx.fillStyle = color;
    ctx.fillRect(bx, by, bw * frac, 4);
  }

  /* Поточний множник зачарування кірки — постійний напис зверху праворуч. */
  private drawEnchantMult(ctx: CanvasRenderingContext2D): void {
    if (!this.run || this.state !== 'RUNNING' || this.enchantMult <= 1) return;
    Render.text(ctx, 'ЗАЧАР. X' + this.enchantMult.toFixed(2).replace(/\.?0+$/, ''),
      this.w - 14, 46 + this.topInset,
      '800 15px ui-monospace, monospace', '#d9a3ff', 'right');
  }

  private drawResult(ctx: CanvasRenderingContext2D): void {
    const round = this.round;
    if (!round) return;
    const a = Math.min(1, this.resultT * 3);
    const bw = Math.min(420, this.w - 40), bh = 176;
    const bx = (this.w - bw) / 2, by = this.h / 2 - bh / 2;
    ctx.globalAlpha = a;

    /* Плашка великого виграшу — НАД панеллю, щоб не тіснити цифри
       всередині неї. З'являється з коротким «наїздом» (масштаб від 1.6
       до 1) і легким пульсом: без руху великий напис читається як
       статичний ярлик, а не як подія. */
    const tier = winTier(round.cost > 0 ? round.payout / round.cost : 0);
    if (tier) {
      const pop = Math.max(1, 1.6 - this.resultT * 4);
      const pulse = 1 + Math.sin(this.resultT * 6) * 0.03;
      const size = Math.round(Math.min(this.w * 0.11, 44) * pop * pulse);
      ctx.save();
      ctx.globalAlpha = a;
      Render.text(ctx, tier.text, this.w / 2, by - 26,
        '900 ' + size + 'px ui-monospace, monospace', tier.color);
      ctx.restore();
    }

    Render.panel(ctx, bx, by, bw, bh, '#2c323b', 5);
    const mid = bx + bw / 2;
    const spent = round.cost || round.bet;
    const net = round.payout - round.cost;

    this.drawMoney(ctx, round.bet, mid, by + 30,
      '700 13px ui-monospace, monospace', '#c8b4e0', 'center', 'СТАВКА ', true);

    this.drawMoney(ctx, round.payout, mid, by + 84,
      '800 46px ui-monospace, monospace', net >= 0 ? '#5ce08a' : '#e05c5c', 'center', '+', true);

    const first = round.tiers.length ? TIER_BY_ID[round.tiers[0]] : null;
    if (round.capped) {
      Render.text(ctx, 'ПОТОЛОК ВЫИГРЫША x' + CONFIG.maxWinX, mid, by + 116,
        '800 15px ui-monospace, monospace', '#ffd34d');
    } else {
      Render.text(ctx,
        first ? `${first.name}  ·  x${(round.payout / spent).toFixed(2)}`
              : 'кирка не выпала — ставка сгорела',
        mid, by + 116, '700 13px ui-monospace, monospace', '#9aa4b2');
    }

    Render.text(ctx, 'клик или пробел — далее',
      mid, by + 152, '700 12px ui-monospace, monospace', '#7a8595');
    ctx.globalAlpha = 1;
  }
}
