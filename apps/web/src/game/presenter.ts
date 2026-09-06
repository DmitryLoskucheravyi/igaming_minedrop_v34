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
const TOAST_LIFE = 1.6;          // скільки секунд живе один push-тост живого логу
const TOAST_MAX = 3;             // скільки тостів одночасно на екрані (старіші зникають)

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
  private fieldW = 0; private fieldX = 0;
  private itemW = 0; private itemH = 0;
  private frameW = 0; private frameH = 0;

  private onHud: (h: HudState) => void;
  private onResize = () => this.layout();
  private onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space') return;
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
    if (this.state === 'RESULT' && this.resultT >= RESULT_GRACE) this.closeResult();
  };

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
    this.emit();
  }

  /** Валюта відображення. Косметика: перемальовує суми на канвасі й у HUD,
      на баланс і математику не впливає. */
  setCurrency(c: CurrencyCode): void {
    this.currency = c;
    this.emit();
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
      return;
    }
    if (this.state !== 'IDLE' || this.busy) return;
    void this.startRound();
  }

  /* ---------------- раунд ---------------- */

  private applyPlayer(p: PlayerState): void {
    this.player = p;
    this.balance = p.balance;
    if (p.config?.rates) this.rates = p.config.rates;
    if (p.config?.bets?.length && !p.config.bets.includes(this.bet)) {
      this.bet = p.config.bets[Math.min(2, p.config.bets.length - 1)];
    }
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
  }

  /* Фон під рулеткою. Ні на що не впливає, тому сид довільний. */
  private decorativeMine(): void {
    this.mine = new Mine(CONFIG.cols, (Math.random() * 0x7fffffff) | 0);
    this.run = null;
    this.particles = [];
    this.popups = [];
    this.camY = this.camMin;
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
      canSpin: (idle && this.balance >= this.bet) || this.state === 'RESULT',
      dryStreak: p?.dryStreak ?? 0,
      pityAt: p?.pityAt ?? CONFIG.pity,
      rates: this.rates,
      busy: this.busy,
      resultEmpty: this.resultEmpty,
      verified: this.verified,
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

  private update(dt: number): void {
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
    if (this.state === 'RESULT') this.resultT += dt;

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
      while (this.acc >= SIM_DT && !this.run.over && n < MAX_TICKS_PER_FRAME) {
        this.acc -= SIM_DT;
        this.run.tick();
        n++;
      }
      if (this.acc > SIM_DT * MAX_TICKS_PER_FRAME) this.acc = SIM_DT * MAX_TICKS_PER_FRAME;
      this.drainEvents();
      if (this.run.over) this.onRunOver();
    }

    // камера тримає найглибшу живу кірку
    let target = this.camMin;
    if (this.run) {
      const alive = this.run.alive;
      const lead = alive.length ? Math.max(...alive.map((p) => p.y)) : this.run.depth;
      target = lead - (this.h * CONFIG.camLead) / this.cell;
    }
    if (target > this.camY || !this.run) {
      this.camY += (target - this.camY) * Math.min(1, dt * CONFIG.camLerp);
    }
    if (this.camY < this.camMin) this.camY = this.camMin;

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

    this.cell = Math.max(CONFIG.minCell, Math.min(CONFIG.maxCell, this.w / CONFIG.cols));
    this.fieldW = this.cell * CONFIG.cols;
    this.fieldX = (this.w - this.fieldW) / 2;

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
    if (this.camY < this.camMin) this.camY = this.camMin;
  }

  private sx(x: number): number { return this.fieldX + x * this.cell; }
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

    this.drawWalls(ctx);

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
    for (let r = r0; r <= r1; r++) {
      const y = this.sy(r);
      for (let c = 0; c < CONFIG.cols; c++) {
        const b = this.mine.get(r, c);
        if (!b || 'wall' in b) continue;
        const x = this.sx(c);
        Render.block(ctx, x, y, cell, b);
        Render.shade(ctx, x, y, cell, r);
      }
    }
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
      if (p.dead) ctx.globalAlpha = 0.25;
      Render.pickaxe(ctx, x, y, this.cell * 1.5, p.tier, p.rot, p.enchanted);
      ctx.globalAlpha = 1;
      if (!p.dead && this.state === 'RUNNING') {
        Render.hpLabel(ctx, x, y - this.cell * 0.92, p.hp, p.hpMax, this.cell);
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

  /* Стіни шахти по боках, якщо поле вужче за екран */
  private drawWalls(ctx: CanvasRenderingContext2D): void {
    if (this.fieldX <= 0) return;
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, this.fieldX, this.h);
    ctx.fillRect(this.fieldX + this.fieldW, 0, this.fieldX + 2, this.h);
  }

  /* Історія ставок — колонка зліва */
  private drawHistory(ctx: CanvasRenderingContext2D): void {
    if (this.w < 720 || !this.history.length) return;
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

  /* Живий лог виграшу — push-тости знизу екрана, без фону: рядок
     з'являється легким свайпом угору знизу, тримається і так само
     зникає свайпом угору й розчиненням (не миготить, не займає місце
     постійною табличкою). Новіші — ближче до самого низу. */
  private drawLiveLog(ctx: CanvasRenderingContext2D): void {
    const n = this.toasts.length;
    if (!n) return;
    const rowH = 24;
    const baseY = this.h - 86;   // трохи вище нижньої панелі кнопок

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
    this.drawMoney(ctx, cash, this.w / 2, 46, '800 20px ui-monospace, monospace', '#ffd34d');
  }

  /* Вікно множника: поки воно активне (run.multWindowT > 0), усе зібране
     множиться на run.multActive. Показуємо великий "X{n}" і смужку часу,
     що спадає, — під сумарним виграшем. Пульсує, коли лишається < 4с. */
  private drawMultWindow(ctx: CanvasRenderingContext2D): void {
    const run = this.run;
    if (!run || this.state !== 'RUNNING' || run.multWindowT <= 0 || run.multActive <= 1) return;

    const y = 78;
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
    Render.text(ctx, 'ЗАЧАР. X' + this.enchantMult.toFixed(2).replace(/\.?0+$/, ''), this.w - 14, 46,
      '800 15px ui-monospace, monospace', '#d9a3ff', 'right');
  }

  private drawResult(ctx: CanvasRenderingContext2D): void {
    const round = this.round;
    if (!round) return;
    const a = Math.min(1, this.resultT * 3);
    const bw = Math.min(420, this.w - 40), bh = 176;
    const bx = (this.w - bw) / 2, by = this.h / 2 - bh / 2;
    ctx.globalAlpha = a;

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
