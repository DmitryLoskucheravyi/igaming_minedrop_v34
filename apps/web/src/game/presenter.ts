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
  BLOCKS, CONFIG, Mine, MULT_WINDOW_SEC, PRUNE_MARGIN, Run, SIM_DT, TIER_BY_ID,
  buildSetup, createRun, streamRoot,
  type RoundResult, type RoundSetup, type Tier, type TierId,
} from '@minedrop/engine';
import type { PlayerState } from '../lib/api';
import {
  CURRENCY_META, FALLBACK_RATES, fmtAmount, fmtWhole,
  type CurrencyCode, type Rates,
} from '../lib/currency';
import { haptic, setupMiniApp } from '../lib/telegram';
import { Assets } from './assets';
import { Music } from './audio';
import { drawBackdrop } from './backdrop';
import { FRAME_ASPECT, FRAME_INNER_BOTTOM, FRAME_INNER_LEFT, FRAME_INNER_RIGHT, FRAME_INNER_TOP, Reel } from './reel';
import { Render, type ReelItem } from './render';
import { Effects, TOAST_LIFE } from './effects';
import { RoundGateway } from './gateway';
import { Camera } from './camera';
import * as Hud from './hud-canvas';
import { BONUS_INTRO_SEC, type HistoryEntry } from './hud-canvas';

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
  /* Скаттери, зібрані в ЦЬОМУ забігу, і скільки їх треба. Показувати
     обов'язково: без лічильника три однакові блоки читаються як звичайна
     руда, і бонуска прилітає нізвідки. */
  scatters: number;
  scatterNeed: number;
  /* Невитрачена бонуска: наступний прокрут буде нею, безкоштовно і на
     збереженій ставці. null — немає. */
  pendingBonus: { bet: number } | null;
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
  /** фонова музика вимкнена (стан живе в localStorage) */
  muted: boolean;
  /** множник ціни бонус баю на кожну кірку (ціна = ставка * множник).
      Приходить із сервера — клієнт лише показує. */
  buyPrices: Record<string, number>;
  fair: { serverSeedHash: string; clientSeed: string; nonce: number } | null;
  error: string | null;
  /** профіль гравця з телеграма: імʼя і @нік (або ID, якщо ніка нема).
      null — стан гравця ще не приїхав із сервера. */
  profile: { name: string; handle: string } | null;
}



const MAX_TICKS_PER_FRAME = 8;   // щоб просадка кадрів не перетворилась на спіраль
const RESULT_GRACE = 0.4;        // мін. затримка перед тим, як клік/пробіл по RESULT щось робить
/* Прискорення програвання раунду (кнопка »).

   x10 і x25 — ТИМЧАСОВІ, суто щоб швидко ганяти раунди під час
   налаштування балансу. Перед релізом прибрати: на таких швидкостях
   від подачі не лишається нічого, а за кадр доводиться проганяти до
   120 кроків фізики. Детермінізм від них не страждає — крок усе одно
   фіксований SIM_DT, просто за кадр їх більше. */
const SPEEDS = [1, 2, 3, 4, 10, 25];
const AUTOPLAY_HOLD = 0.9;       // скільки показувати результат перед авто-наступним раундом
/* Огорожа — рівно ОДИН шар блоків за кожним краєм поля. Далі нічого:
   фон углиб, який уже намалював drawSky() (backdrop.ts). Огорожа суто
   декоративна — у фізиці межа шахти є завжди, незалежно від того, що
   намальовано. */
const FENCE_COLS = 1;

/* ---- освітлення навколо кірки ----
   Зона, у якій кірка зараз працює, лишається такою ж яскравою, як була;
   усе, що далі за DIM_NEAR клітинок від будь-якої кірки, гасне до
   DIM_MAX. Перехід розтягнутий на DIM_FADE клітинок — різка межа
   читалась би як круглий ліхтарик, а не як природний спад світла. */
const DIM_NEAR = 2;      // радіус повністю освітленої зони, у клітинках
const DIM_FADE = 1.6;    // на скількох клітинках світло згасає
const DIM_MAX = 0.42;    // наскільки темнішає найдальше. 0.28 -> 0.42, в 1.5 раза

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
   лишатись тією самою секундою. */
const PAN_HOLD = 1;       // секунда спокою до повернення фокуса на кірку
const PAN_MIN_PX = 6;     // менший рух — це тап, а не гортання
/* На скільки рядів можна відвести кадр угору від кірки. Число НЕ
   довільне: вище межі прунингу рушій ряди вже викинув, і Mine.peek()
   перерахує їх цілими — розбиті блоки на екрані «заростуть». Тому
   ліміт береться від PRUNE_MARGIN із запасом, а не вгадується. */
const PAN_LIMIT = PRUNE_MARGIN - 20;

/* ---- плашки великого виграшу ----
   Пороги в іксах від ставки. Прив'язані до реального розподілу виплат
   (sim:final): x5 ≈ верхні 5% раундів, x15 ≈ 1%, x40 ≈ 0.1%. Тобто
   «BIG WIN» справді рідкісний, а не з'являється через раз — інакше
   плашка нічого не означає. Береться найвищий досягнутий поріг. */


/* Наскільки зменшено рамку рулетки проти розміру, який дає доступний
   простір. Символ усередині масштабується разом із нею — він похідна
   від розмірів рамки, а не самостійна величина. */
const FRAME_SCALE = 0.8;

/* ---- розмір кірки на полі ----
   ВИДИМИЙ розмір спрайту в клітинках (Render.pickaxe сам добере
   полотно під поля конкретного скіну — див. Assets.pickFill).

   Було 1.5 полотна старого скіну, у якому малюнок займав 0.8125 —
   тобто видимих 1.5 * 0.8125 = 1.22 клітинки. Нові скіни намальовані
   впритул до країв, і якби множник лишився 1.5, кірка на полі
   виросла б у 1.23 раза. Беремо 1.22 — картинка на екрані лишається
   рівно такою ж, як була.

   ЧОМУ НЕ ЧІПАЄМО bodyR (0.55 клітинки, packages/engine/config.ts):
   видимий розмір не змінився, отже й узгодженість «bodyR ≈ половина
   спрайту» лишилась на місці. bodyR читає СЕРВЕР, і його зміна
   переписала б кожну траєкторію, RTP і всі збережені реплеї — платити
   цим за те, щоб картинка лишилась тією самою, немає за що. */
const PICK_VIS = 1.22;

/* ---- спалахи-картинки ----
   Розміри в клітинках і тривалості в секундах для fx-спрайтів
   (див. Effects.sprite). Вибух TNT більший за клітинку — він і
   рознесло більше за одну; силуети кірки трохи більші за саму кірку,
   бо це «слід», який має її обганяти. */
const FX_TNT_SIZE = 3.2;
const FX_TNT_LIFE = 0.3;
const FX_TRAIL_SIZE = 2.0;
const FX_TRAIL_LIFE = 0.2;
/* На скільки клітинок відсунути слід НАЗАД по напрямку руху — щоб він
   читався як шлейф позаду кірки, а не як друга кірка поверх неї. */
const FX_TRAIL_BACK = 0.45;

/* Мінімальна висота цифри растрового шрифту, у пікселях екрана.
   У листі цифра 18 px заввишки; nearest-neighbour стискає її без
   згладжування, і нижче ~14 px штрихи починають рватись — тоді це вже
   не «піксельний шрифт», а каша. Тому на дрібній клітинці попап
   лишається трохи більшим, ніж був системним шрифтом, замість того
   щоб стати нечитабельним. */
const POPUP_PIXEL_MIN = 14;


export class Presenter {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private reel = new Reel();
  /* Розмова з сервером — окремо (game/gateway): повтор при обриві й
     ключ ідемпотентності не мають лежати посеред анімації. */
  private readonly net = new RoundGateway();
  private raf = 0;
  private disposed = false;
  /** музику вже почали вантажити (після першого кадру) */
  private musicArmed = false;
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
  /** скаттерів зібрано в поточному раунді */
  private scatters = 0;
  /* Заставка «БОНУС ГЕЙМ» перед безкоштовним раундом. Тримається
     стільки секунд; поки йде — рулетка не крутиться. */
  private bonusIntro = 0;

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
  /* Камера — окремим об'єктом (game/camera): координата кадру, пауза
     після гортання й ведення за кіркою. */
  private readonly cam = new Camera();
  /* Масштаб лишається ТУТ, а не в камері: від нього залежить cell, а
     отже вся розкладка (geometry) — розміри рамки рулетки, символів,
     шрифтів. Камера ж масштабу не знає взагалі: вона віддає координати
     в клітинках, а в пікселі їх переводить той, хто малює. */
  private zoom = 1;
  private shake = 0;
  private flash = 0;
  private flashColor = '#fff';
  private resultT = 0;
  private timer = 0;
  private timerFn: (() => void) | null = null;
  private acc = 0;
  /* Іскри, спливаючі числа й живий лог — окремим шаром (game/effects).
     На виплату вони не впливають, тому й тримати їх разом зі станом
     раунду не було чого. */
  private readonly fx = new Effects();

  /* геометрія */
  private w = 0; private h = 0; private cell = 0; private dpr = 1;
  private itemW = 0; private itemH = 0;
  /* Годинник для анімацій, що живуть незалежно від раунду (спалахи
     паличок на кільці). Реальний час, без множення на speed:
     підсвітка прогресу не має розганятись разом із фізикою. */
  private clock = 0;
  /* Сегмент кільця, що загорівся щойно: індекс і скільки ще триває
     спалах. Без цього новий стан просто з'являвся б — видно було б
     результат, але не подію. */
  private pipLit = -1;
  private pipLitT = 0;
  private prevStreak = -1;
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

  /* Жести (зум і гортання) працюють ТІЛЬКИ поки кірка в шахті.
     Поза забігом на екрані рулетка й декоративна шахта — рухати й
     масштабувати там нічого, а випадковий щипок чи протяжка лише
     збивали б кадр перед наступною ставкою. */
  private get canGesture(): boolean {
    return !!this.run && (this.state === 'RUNNING' || this.state === 'DROPDONE');
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragged = 0;
    if (!this.canGesture) return;
    if (this.pointers.size === 2) {
      this.pinchDist = this.pointerSpread();
      this.pinched = true;
      /* Другий палець доклали БЕЗ відриву першого від гортання —
         panning лишився true від одно-пальцевої фази, і поки триває
         сам щипок, камера не повернулась би до кірки взагалі, хоча
         zoom сам собою на це не мав впливати (див. коментар нижче біля
         setZoom). Явно віддаємо контроль назад стеженню. */
      this.cam.panning = false;
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dy = e.clientY - prev.y;
    const dx = e.clientX - prev.x;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this.canGesture) return;

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
    this.cam.grab();                         // камера чекає, доки палець не зникне з екрана

    /* Не даємо загубитись: далі PAN_LIMIT рядів від кірки відходити
       нема сенсу, а рендер там уперся б у ряди, давно викинуті
       прунингом (їх довелось би перегенеровувати щокадру). */
    const p = this.run?.picks[0];
    this.cam.panBy(
      dy / this.cell,
      p ? p.y - PAN_LIMIT : -Infinity,
      p ? p.y + PAN_LIMIT : Infinity,
    );
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    if (this.pointers.size === 0) {
      /* Останній палець зник з екрана — САМЕ ТУТ, а не в onPointerMove,
         запускаємо відлік паузи. Раніше PAN_HOLD виставлявся при
         кожному русі, тож завмер пальця без відриву від екрана вже
         запускав відлік — камера могла почати їхати назад до кірки,
         поки гравець ще притискає поле. */
      this.cam.release(PAN_HOLD);
      /* Прапорець тримаємо до повного відпускання: браузер шле click уже
         після того, як пальці зникли, і без цього щипок чи гортання
         гасили б екран результату. */
      if (this.pinched) setTimeout(() => { this.pinched = false; }, 120);
    }
  };

  /** Масштаб у межах ZOOM_MIN..ZOOM_MAX. Публічний — знадобиться, якщо
      колись з'явиться кнопка скидання масштабу. */
  setZoom(z: number): void {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (Math.abs(next - this.zoom) < 0.002) return;

    /* Масштабуємо ВІД ЦЕНТРУ ЕКРАНА. camX/camY — це лівий верхній кут
       кадру (sx = (x - camX) * cell), тому сама лише зміна cell тягне
       світ від краю екрана, і при віддаленні поле повзе вбік. Тому
       запам'ятовуємо світову точку, що зараз у центрі, і після зміни
       масштабу повертаємо її рівно туди ж. */
    const before = this.cam.centerNow(this.w, this.h, this.cell);
    this.zoom = next;
    this.geometry();
    this.cam.centerAfterZoom(before, this.w, this.h, this.cell);
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
    /* Фонова музика. arm() лише чіпляє одноразовий слухач першого
       дотику по канвасу — сам файл ще не вантажиться. */
    Music.arm(this.canvas);
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
      const p = await this.net.me();
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
    Music.dispose();
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
      /* Музику (1.6 МБ) вантажимо ПІСЛЯ першого намальованого кадру, а
         не разом із ним — див. шапку audio.ts. Заграє вона все одно
         лише з першого дотику, автоплей заборонений. */
      if (!this.musicArmed) { this.musicArmed = true; Music.prefetch(); }
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

  /* Звук. Прискорення раунду (x2/x3/x10) на музику НЕ впливає: трек
     живе в реальному часі, а не в часі симуляції. */
  toggleMute(): void {
    Music.toggle();
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
  /* Спільне для всіх написів HUD: розмір полотна, зсув під стрічку
     історії й форматування грошей у валюті гравця. */
  private hudCtx(ctx: CanvasRenderingContext2D): Hud.HudCtx {
    return {
      ctx,
      w: this.w,
      h: this.h,
      topInset: this.topInset,
      money: (rub, x, y, font, color, align, prefix, whole) =>
        this.drawMoney(ctx, rub, x, y, font, color, align, prefix, whole),
      moneyStr: (rub, whole) => this.moneyStr(rub, whole),
      currency: this.currency,
      monoCurrency: CURRENCY_META[this.currency].mono,
    };
  }

  /** Сума в поточній валюті рядком, без значка (його малюють окремо). */
  private moneyStr(rub: number, whole = false): string {
    return whole
      ? fmtWhole(rub, this.currency, this.rates)
      : fmtAmount(rub, this.currency, this.rates);
  }

  private drawMoney(
    ctx: CanvasRenderingContext2D, rub: number, x: number, y: number,
    font: string, color: string, align: CanvasTextAlign = 'center', prefix = '+',
    whole = false,
  ): void {
    const meta = CURRENCY_META[this.currency];
    Render.money(ctx, prefix + this.moneyStr(rub, whole), x, y, font, color,
      this.currency, meta.mono, align);
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
      p = await this.net.me();
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

  /* Ставка, за якою СЕРВЕР порахував цей раунд.

     Не this.bet: у виграної бонуски ставка своя — та, на якій зібрано
     скаттери, — і вона може не збігатися з обраною в HUD. Через це всі
     суми на екрані (попапи, лог, сумарний виграш) рахувались би з
     чужого номіналу, а панель у кінці показувала б серверне число:
     одна сума падає, інша показується, третя лягає на баланс.

     Поки раунду немає — обрана ставка, її й показує HUD. */
  private get runBet(): number {
    return this.round?.bet ?? this.bet;
  }

  /** Ціна бонуски для кірки за поточної ставки, у рублях. */
  buyPrice(tier: TierId): number {
    const k = this.player?.config?.buyPrices?.[tier] ?? CONFIG.buy.price[tier] ?? 0;
    return Math.round(this.bet * k);
  }

  /** БОНУС БАЙ: купити гарантовану кірку. Гроші й результат рахує
      сервер — тут лише перевірка «чи є сенс питати». */
  buyBonus(tier: TierId): void {
    if (this.busy) return;
    if (this.state !== 'IDLE' && this.state !== 'RESULT') return;
    if (this.balance < this.buyPrice(tier)) { this.notEnough(); return; }
    if (this.state === 'RESULT') this.closeResult();
    void this.startRound(tier);
  }

  private async startRound(buy?: TierId): Promise<void> {
    this.busy = true;
    this.error = null;
    this.verified = null;
    this.message = 'запрос на сервер…';
    this.emit();

    /* Повтор при обриві й ключ ідемпотентності — у шлюзі. Сюди
       повертається або раунд, або готовий текст для гравця. */
    const res = await this.net.play(this.bet, buy);
    if (!res.ok) {
      this.busy = false;
      this.autoplay = false;    // не молотимо запитами по колу
      this.error = res.message;
      this.message = res.message;
      this.emit();
      return;
    }

    const { round, player } = res;
    this.player = player;
    this.round = round;
    this.busy = false;

    /* Баланс під час раунду: списане вже пішло, виплату покажемо в кінці */
    this.balance = round.balanceBefore - round.cost;

    /* Розбираємо сид САМІ. Якщо сервер прислав спини, яких із цього
       сида не виходить, — це не наша гра, і про це треба сказати вголос. */
    this.setup = buildSetup(round.seed, round.pity, round.buy, !!round.free);
    if (this.setup.spins.join() !== round.spins.join()
      || this.setup.tiers.join() !== round.tiers.join()
      || this.setup.startCols.join() !== round.startCols.join()) {
      this.verified = false;
      this.setup = { mode: round.mode, spins: round.spins, tiers: round.tiers,
                     startCols: round.startCols, pity: round.pity,
                     bonus: !!round.buy || !!round.free, free: !!round.free };
    }

    this.spinIndex = 0;
    this.shown = [];
    this.stageTarget = 0;
    this.resultT = 0;
    this.acc = 0;
    this.scatters = 0;
    /* Шахта береться з setup.bonus, а не з наявності round.buy: виграна
       бонуска теж бонусна, але нічого не куплено. Помилка тут була б
       тихою — клієнт згенерував би звичайну шахту й розійшовся з
       сервером на першому ж блоці. */
    this.newMine(round.seed, this.setup.bonus);

    /* Безкоштовна бонуска починається з плашки. Вона не косметична:
       раунд списав нуль і кірка взялася нізвідки — без заставки це
       виглядає як збій, а не як виграш. */
    if (round.free) {
      this.bonusIntro = BONUS_INTRO_SEC;
      this.message = 'БОНУС ГЕЙМ';
      this.emit();
      this.wait(BONUS_INTRO_SEC, () => { this.bonusIntro = 0; this.nextSpin(); });
      return;
    }

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
    // ручне гортання належало тому забігу — на головному екрані камера
    // має стояти там, де стоїть, без залишкової паузи
    this.cam.reset();
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

  private newMine(seed: string, bonus = false): void {
    this.mine = new Mine(CONFIG.cols, streamRoot(seed, 'mine'), bonus);
    this.run = null;
    this.fx.clearAll();
    this.cam.toIdle();
  }

  /* Фон під рулеткою. Ні на що не впливає, тому сид довільний. */
  private decorativeMine(): void {
    this.mine = new Mine(CONFIG.cols, (Math.random() * 0x7fffffff) | 0);
    this.run = null;
    this.fx.clearField();
    this.cam.toIdle();
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
      scatters: this.scatters,
      scatterNeed: CONFIG.scatter.need,
      pendingBonus: p?.pendingBonus ?? null,
      rates: this.rates,
      busy: this.busy,
      resultEmpty: this.resultEmpty,
      verified: this.verified,
      speed: this.speed,
      autoplay: this.autoplay,
      muted: Music.isMuted,
      buyPrices: p?.config?.buyPrices ?? CONFIG.buy.price,
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

  /* Силует кірки як СЛІД руху (fx/pick-*.png). Орієнтуємо за
     напрямком швидкості: на спрайті кірка дивиться вгору-праворуч,
     тобто її власна вісь — -45°, тому до кута швидкості додаємо PI/4.
     Сам слід зсуваємо НАЗАД по руху, щоб він читався як шлейф позаду
     кірки, а не як друга кірка поверх неї.

     Кірка майже стоїть (одразу після удару таке буває) — напрямку
     немає, беремо її власний кут і не зсуваємо. */
  private trail(key: string, idx: number): void {
    const p = this.run?.picks[idx];
    if (!p) return;
    const len = Math.hypot(p.vx, p.vy);
    const moving = len > 0.3;
    const rot = moving ? Math.atan2(p.vy, p.vx) + Math.PI / 4 : p.rot;
    const bx = moving ? (-p.vx / len) * FX_TRAIL_BACK : 0;
    const by = moving ? (-p.vy / len) * FX_TRAIL_BACK : 0;
    this.fx.sprite(key, p.x + bx, p.y + by, FX_TRAIL_SIZE * p.scale, FX_TRAIL_LIFE, rot);
  }

  private drainEvents(): void {
    const r = this.run;
    if (!r) return;
    for (const e of r.events) {
      if (e.t === 'crack') {
        this.fx.burst(e.c + 0.5, e.r + 0.5, BLOCKS[e.id].color, 4, 0.7);
        this.shake = Math.min(10, this.shake + 1.6);
      } else if (e.t === 'break') {
        this.fx.burst(e.c + 0.5, e.r + 0.5, BLOCKS[e.id].color, 12);
        // живий попап показує РЕАЛЬНУ суму (після ставки й payoutK), дробову
        // за потреби — щоб цифри на екрані не брехали і не тонули в нулі
        const cash = e.got * this.runBet / CONFIG.payoutK;
        if (cash > 0) {
          this.fx.popup({ x: e.c + 0.5, y: e.r + 0.5, life: 1.0,
            text: '', color: BLOCKS[e.id].color, size: 0.2, money: cash });
          this.fx.log(BLOCKS[e.id].name, BLOCKS[e.id].color, cash);
        }
        this.shake = Math.min(14, this.shake + 3);
      } else if (e.t === 'mult') {
        // блок-множник більше не іксує зібране — відкриває вікно на e.secs
        // секунд, поки воно активне, усе зібране множиться на e.active
        this.fx.burst(e.c + 0.5, e.r + 0.5, '#ffd34d', 44, 2.4);
        this.shake = 22;
        this.flash = 0.45; this.flashColor = '#ffd34d';
        // secs 0 — бонуска: множник стакнутий до кінця забігу, таймера нема
        const mtext = e.secs > 0
          ? 'X' + e.active + ' · ' + e.secs + 'с'
          : 'X' + Math.round(e.active);
        this.fx.popup({ x: e.c + 0.5, y: e.r + 0.5, life: 1.8,
          text: mtext, color: '#ffe98a', size: 0.34 });
        this.fx.log(
          e.secs > 0 ? 'Множитель X' + e.active + ' на ' + e.secs + 'с'
                     : 'Множитель X' + e.m + ' -> X' + Math.round(e.active),
          '#ffe98a');
        haptic('hit');
      } else if (e.t === 'tnt') {
        // намальований вибух поверх іскор — короткий, із загасанням і ростом
        this.fx.sprite('fx.tntBlast', e.c + 0.5, e.r + 0.5, FX_TNT_SIZE, FX_TNT_LIFE, 0, 1.25);
        this.trail('fx.pickTnt', e.pick);
        this.fx.burst(e.c + 0.5, e.r + 0.5, '#ff8a2b', 46, 3);
        for (const h of e.hit) this.fx.burst(h.c + 0.5, h.r + 0.5, BLOCKS[h.id].color, 8);
        // e.got — реальна сума (вже з урахуванням зачарування), не
        // перераховуємо з e.hit клієнтом, бо множник зачарування —
        // рантайм-стан кірки, його нема в статичній таблиці BLOCKS
        const cash = e.got * this.runBet / CONFIG.payoutK;
        this.shake = Math.min(34, 22 + e.chain * 3);
        this.flash = 0.35; this.flashColor = '#ff7a2b';
        const boom = e.chain > 1 ? 'БУМ X' + e.chain : 'БУМ!';
        this.fx.popup({ x: e.c + 0.5, y: e.r + 0.5, life: 1.3,
          text: boom, color: '#ff8a2b', size: 0.26,
          money: cash > 0 ? cash : undefined, prefix: boom + ' +' });
        if (cash > 0) this.fx.log(boom, '#ff8a2b', cash);
      } else if (e.t === 'scatter') {
        /* Останній скаттер — це вже подія рівня великого виграшу, тому
           й реакція інша: не той самий попап, що на перших двох. */
        const done = e.n >= e.need;
        this.scatters = e.n;
        this.fx.burst(e.c + 0.5, e.r + 0.5, '#ff9a3c', done ? 48 : 24, done ? 2.6 : 1.4);
        this.shake = done ? 26 : 12;
        if (done) { this.flash = 0.5; this.flashColor = '#ff9a3c'; }
        this.fx.popup({
          x: e.c + 0.5, y: e.r + 0.5, life: done ? 2 : 1.3,
          text: done ? 'БОНУС ГЕЙМ!' : `СКАТТЕР ${e.n}/${e.need}`,
          color: '#ffc27a', size: done ? 0.3 : 0.22,
        });
        this.fx.log(
          done ? 'ТРИ СКАТТЕРА — БОНУСКА!' : `Скаттер ${e.n}/${e.need}`,
          '#ffc27a');
        haptic(done ? 'win' : 'hit');
      } else if (e.t === 'tntchain') {
        // бонус за довгий ланцюг детонацій — на весь виграш вибуху
        this.shake = 24;
        this.flash = 0.5; this.flashColor = '#ff9a3c';
        const cash = e.extra * this.runBet / CONFIG.payoutK;
        this.fx.popup({ x: e.c + 0.5, y: e.r + 0.5, life: 1.8,
          text: 'TNT CHAIN X' + e.chain, color: '#ffb15a', size: 0.3,
          money: cash > 0 ? cash : undefined,
          prefix: 'TNT CHAIN X' + e.chain + '  +' + Math.round((e.mult - 1) * 100) + '%  +' });
        this.fx.log('TNT CHAIN X' + e.chain + ' · +' + Math.round((e.mult - 1) * 100) + '%',
          '#ffb15a', cash > 0 ? cash : undefined);
        haptic('win');
      } else if (e.t === 'upgrade') {
        /* ВЕРСТАК: підвищення тіру / повний хіл / дохіл на topUp HP
           (Diamond, кожен верстак після першого). */
        this.fx.burst(e.c + 0.5, e.r + 0.5, '#ffb347', 40, 2.2);
        this.shake = 16;
        this.flash = 0.4; this.flashColor = '#ffb347';
        this.trail('fx.pickWorkbench', e.pick);
        const tierName = (TIER_BY_ID[e.tier]?.name ?? e.tier).toUpperCase();
        const label = e.topUp > 0 ? '+' + e.topUp + ' HP'
          : e.healOnly ? 'ПОЛНЫЙ ХИЛ!'
          : 'ПОВЫШЕНИЕ! ' + tierName;
        this.fx.popup({ x: e.c + 0.5, y: e.r + 0.5, life: 1.6,
          text: label, color: '#ffe0b3', size: 0.22 });
        this.fx.log(label, '#ffe0b3');
      } else if (e.t === 'grow') {
        // СТРІЛКА ВГОРУ: кірка більшає (разом із радіусом зіткнення й HP)
        this.trail('fx.pickGrow', e.pick);
        this.fx.burst(e.c + 0.5, e.r + 0.5, '#3ad1a0', 46, 2.6);
        this.shake = 20;
        this.flash = 0.45; this.flashColor = '#3ad1a0';
        this.fx.popup({ x: e.c + 0.5, y: e.r + 0.5, life: 1.7,
          text: 'X' + e.scale + '  ' + e.secs + 'с', color: '#8ff5d5', size: 0.3 });
        this.fx.log(
          e.stacks > 1 ? 'Рост X' + e.scale + ' (' + e.stacks + ' подряд)' : 'Рост X' + e.scale,
          '#8ff5d5');
        haptic('win');
      } else if (e.t === 'rubber') {
        // ГУМА: трамплін — сильний відскок і швидке падіння після нього
        this.fx.burst(e.c + 0.5, e.r + 0.5, '#ff7ec4', 30, 2.2);
        this.shake = Math.max(this.shake, 14);
        this.fx.popup({ x: e.c + 0.5, y: e.r + 0.5, life: 1.1,
          text: 'ОТСКОК!', color: '#ffb8de', size: 0.24 });
        haptic('hit');
      } else if (e.t === 'pickdead') {
        this.fx.burst(e.x, e.y, '#8a939f', 22, 1.4);
        this.shake = Math.max(this.shake, 12);
      }
    }
    r.events.length = 0;
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
    /* dtReal, а не dt: пульс каменів не має прискорюватись кнопкою x2. */
    this.clock += dtReal;
    if (this.pipLitT > 0) this.pipLitT = Math.max(0, this.pipLitT - dtReal);

    /* Серія росте тільки між раундами, тож ловимо зміну тут, а не в
       обробці подій забігу. */
    const streakNow = this.player?.dryStreaks?.[this.bet] ?? 0;
    if (streakNow !== this.prevStreak) {
      if (this.prevStreak >= 0 && streakNow > this.prevStreak) {
        this.pipLit = streakNow - 1;
        this.pipLitT = 0.45;
      }
      this.prevStreak = streakNow;
    }

    if (this.bonusIntro > 0) this.bonusIntro = Math.max(0, this.bonusIntro - dt);

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

    /* Камера веде кірку сама (game/camera): і правило ведення, і пауза
       після гортання описані там. Звідси приходить тільки ціль — та
       кірка, за якою стежити, — і два різні кроки часу: прискорений
       для лерпу й реальний для паузи. */
    const alive = this.run?.alive ?? [];
    const lead = this.run ? (alive.length ? alive[0] : this.run.picks[0]) ?? null : null;
    this.cam.follow(dt, dtReal, this.w / this.cell, lead, !!this.run, this.h, this.cell);

    /* Останній рубіж: кадр не має підійматись вище за межу прунингу,
       хоч би звідки прийшов рух — гортання, зум чи лерп камери. Вище
       неї рушій ряди вже викинув, і намальовані там блоки будуть
       свіжозгенерованими, тобто цілими. Гортання й так обмежене
       PAN_LIMIT, але сильне віддалення піднімає верх кадру саме по
       собі, без жодного жесту. */
    if (this.run) {
      let top = Infinity;
      for (const p of this.run.picks) if (p.y < top) top = p.y;
      if (Number.isFinite(top)) this.cam.clampToPrune(top);
    }

    this.fx.step(dt);
  }

  /* ---------------- РОЗКЛАДКА ---------------- */

  private layout(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.dpr = dpr;
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
    this.cam.idleX = (CONFIG.cols - this.w / this.cell) / 2;

    /* Рамка вікна рулетки — растрове зображення (ui/reel-frame.png) з фіксованим
       співвідношенням сторін, тому розмір комірки-символу тепер похідна
       від розміру РАМКИ, а не навпаки: спершу вписуємо всю рамку в
       доступний простір (за висотою, з обмеженням по ширині), потім
       ділимо її внутрішнє прозоре вікно на R.visible рівних комірок. */
    const R = CONFIG.reel;
    let frameH = Math.max(280, Math.min(560, this.h * 0.86));
    let frameW = frameH * FRAME_ASPECT;
    const maxFrameW = this.w - 16;
    if (frameW > maxFrameW) { frameW = maxFrameW; frameH = frameW / FRAME_ASPECT; }
    /* Множник застосовуємо ПІСЛЯ всіх обмежень, а не до них: інакше на
       вузькому екрані рамку спершу підрізав би maxFrameW, і зменшення
       вийшло б меншим за обіцяні 20%. */
    frameW *= FRAME_SCALE;
    frameH *= FRAME_SCALE;
    this.frameW = frameW;
    this.frameH = frameH;
    this.itemW = frameW * (FRAME_INNER_RIGHT - FRAME_INNER_LEFT);
    this.itemH = (frameH * (FRAME_INNER_BOTTOM - FRAME_INNER_TOP)) / R.visible;

    // найвища точка камери: поки крутиться рулетка, поверхня стоїть низько
    this.cam.minY = -(this.h * CONFIG.camIdle) / this.cell;
    // під час забігу камера вільна (стежить за кіркою) — підтягуємо її
    // до межі лише в стані спокою, інакше зміна розміру екрана смикала б
    // кадр посеред польоту
    if (!this.run) this.cam.clampIdle();
  }

  private sx(x: number): number { return (x - this.cam.x) * this.cell; }
  private sy(y: number): number { return (y - this.cam.y) * this.cell; }

  /* ---------------- DRAW ---------------- */

  private draw(): void {
    const ctx = this.ctx;
    Render.pixelate(ctx);
    this.drawSky(ctx);

    ctx.save();
    if (this.shake > 0) ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    this.drawMine(ctx);
    this.drawParticles(ctx);
    this.drawSprites(ctx);
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
      /* Затемнення шахти на час рулетки. Текстура сюди НЕ йде: фон
         належить самому слоту й малюється всередині вікна рамки
         (reel.draw), а не на весь кадр. */
      ctx.fillStyle = 'rgba(4,6,9,' + (0.62 * a).toFixed(3) + ')';
      ctx.fillRect(0, 0, this.w, this.h);
      const cy = this.h * 0.42 + this.stage * this.itemH * 0.9;
      const fa = Math.min(1, a * 1.7);

      /* Прогрес до гарантованої кірки — ПЕРЕД кільцем, бо сегменти в
         ньому прозорі й колір їм дає заливка знизу. Гасне разом із
         кільцем (fa), щоб не висіти в повітрі під час переходу до
         поля. */
      ctx.save();
      ctx.globalAlpha = fa;
      this.reel.drawSegments(
        ctx, this.w / 2, cy, this.frameW, this.frameH,
        this.player?.dryStreaks?.[this.bet] ?? 0,
        this.player?.pityAt ?? CONFIG.pity,
        this.clock,
        this.pipLitT > 0 ? this.pipLit : -1,
      );
      ctx.restore();

      this.reel.draw(ctx, this.w / 2, cy, this.frameW, this.frameH, this.itemW, this.itemH, fa);
    }

    /* HUD поверх поля — окремим шаром (game/hud-canvas). Кожен напис
       отримує рівно те, що йому потрібно, і змінити стан гри жоден із
       них уже не може. */
    const hud = this.hudCtx(ctx);
    const running = this.state === 'RUNNING';
    Hud.drawHistory(hud, this.history);
    Hud.drawLiveLog(hud, this.fx.toasts, this.playing);
    Hud.drawRunningTotal(hud, this.run, this.runBet, running);
    Hud.drawMultWindow(hud, this.run, running);
    Hud.drawScatters(hud, this.scatters, running);
    if (this.state === 'RESULT' && !this.resultEmpty) Hud.drawResult(hud, this.round, this.resultT);
    /* Заставка малюється ОСТАННЬОЮ і поверх усього: вона й має
       перекрити поле, поки бонуска ще не почалась. */
    if (this.bonusIntro > 0) Hud.drawBonusIntro(hud, this.bonusIntro);
  }

  /* Небо й хмари — усе в backdrop.ts. Екранний шар: не залежить від
     камери чи глибини забігу, тож і сюди передаємо лише розмір
     екрана, час і dpr (для розміру розмиття — див. backdrop.ts). */
  private drawSky(ctx: CanvasRenderingContext2D): void {
    drawBackdrop(ctx, this.w, this.h, this.clock, this.dpr);
  }

  private drawMine(ctx: CanvasRenderingContext2D): void {
    if (!this.mine) return;
    const cell = this.cell;
    const r0 = Math.max(0, Math.floor(this.cam.y) - 1);
    const r1 = Math.ceil(this.cam.y + this.h / cell) + 1;
    const c0 = Math.floor(this.cam.x) - 1;
    const c1 = Math.ceil(this.cam.x + this.w / cell) + 1;

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
           там лишається фон углиб, який уже намалював drawSky(). Огорожа
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
    for (const p of this.fx.particles) {
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
      const size = this.cell * PICK_VIS * p.scale;
      if (p.dead) ctx.globalAlpha = 0.25;
      Render.pickaxe(ctx, x, y, size, p.tier, p.rot);
      ctx.globalAlpha = 1;
      if (!p.dead && this.state === 'RUNNING') {
        /* Підпис HP тримається над спрайтом. Множник 0.76 (а не
           колишні 0.62) — щоб АБСОЛЮТНИЙ просвіт лишився таким самим:
           size тепер видимий розмір, а не полотно, і воно на 19%
           менше. Кірка йде по діагоналі, тож її півдіагональ —
           size * 0.707; 0.76 лишає над нею той самий запас, що й
           раніше, і підпис не наїжджає на вістря, під яким би кутом
           кірка не крутилась. */
        Render.hpLabel(ctx, x, y - size * 0.76, p.hp, p.hpMax, this.cell);
      }
    }
  }

  /* Спалахи-картинки (вибух TNT, силуети кірки). Малюються ПІСЛЯ
     шахти й іскор, але ПЕРЕД самою кіркою: слід має лишатись позаду
     неї, а не накривати її собою. */
  private drawSprites(ctx: CanvasRenderingContext2D): void {
    for (const s of this.fx.sprites) {
      const img = Assets.get(s.key);
      if (!img) continue;                       // ще не довантажився — просто без ефекту
      const k = 1 - s.life / s.max;             // 0 на старті, 1 наприкінці
      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      if (!nw || !nh) continue;
      const w = s.size * this.cell * (1 + (s.grow - 1) * k);
      const h = w * (nh / nw);
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - k);     // рівне згасання за життя
      ctx.translate(this.sx(s.x), this.sy(s.y));
      if (s.rot) ctx.rotate(s.rot);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private drawPopups(ctx: CanvasRenderingContext2D): void {
    for (const p of this.fx.popups) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.4));
      const font = '800 ' + Math.round(this.cell * p.size) + 'px ui-monospace, monospace';
      if (p.money != null) {
        const meta = CURRENCY_META[this.currency];
        const str = (p.prefix ?? '+') + this.moneyStr(p.money);
        /* Растровий шрифт бере на себе ЛИШЕ те, що з нього можна
           набрати: цифри, '+', кому, 'x', '/'. Попап із кирилицею
           ('БУМ! +12') він не потягне — pixelMoney чесно скаже false,
           і рядок піде системним шрифтом, як і раніше. */
        const done = Render.pixelMoney(
          ctx, str, this.sx(p.x), this.sy(p.y),
          Math.max(POPUP_PIXEL_MIN, Math.round(this.cell * p.size * 1.35)),
          p.color, this.currency, meta.mono);
        if (!done) {
          this.drawMoney(ctx, p.money, this.sx(p.x), this.sy(p.y), font, p.color, 'center', p.prefix ?? '+');
        }
      } else {
        Render.text(ctx, p.text, this.sx(p.x), this.sy(p.y), font, p.color);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* Раунд розігрується на полі. Ті самі стани, за якими GameClient
     ховає нижню панель кнопок (див. PLAYING_STATES там і
     .controls.playing у globals.css). */
  private get playing(): boolean {
    return this.state === 'SPIN' || this.state === 'RISE'
      || this.state === 'RUNNING' || this.state === 'DROPDONE';
  }

  /* Наскільки вниз посунути верхній HUD (сумарний виграш, вікно
     множника): на телефоні верхню смугу займає стрічка історії, і без
     цього зсуву написи лягали б один на одного. */
  private get topInset(): number {
    return this.w < 720 && this.history.length ? 42 : 0;
  }
}
