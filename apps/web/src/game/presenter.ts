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
  BLOCKS, CONFIG, Mine, Run, SIM_DT, TIER_BY_ID, buildSetup, createRun, streamRoot,
  type RoundMode, type RoundResult, type RoundSetup, type Tier,
} from '@minedrop/engine';
import { Api, ApiError, type PlayerState } from '../lib/api';
import { haptic, setupMiniApp } from '../lib/telegram';
import { Assets } from './assets';
import { Reel } from './reel';
import { Render, type ReelItem } from './render';

const roundKey = () =>
  globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(36).slice(2);

type State = 'LOADING' | 'IDLE' | 'SPIN' | 'RISE' | 'RUNNING' | 'DROPDONE' | 'RESULT' | 'ERROR';

export interface HudState {
  state: State;
  balance: number;
  bet: number;
  bets: number[];
  streak: number;
  streakNeeded: number;
  bonusPending: boolean;
  buyCost: number;
  message: string;
  canSpin: boolean;
  canBuy: boolean;
  spinLabel: string;
  busy: boolean;
  /** RESULT без жодного виграшу (кірка не випала або нічого не зловила) —
      показувати модалку "+0" нема сенсу, HUD сам скаже коротко в статусі. */
  resultEmpty: boolean;
  /** null — ще не перевіряли; true — клієнт зійшовся з сервером */
  verified: boolean | null;
  fair: { serverSeedHash: string; clientSeed: string; nonce: number } | null;
  error: string | null;
}

interface HistoryEntry {
  item: ReelItem;
  win: number;
  cost: number;
  x: number;
  bonus: boolean;
}

interface Particle { x: number; y: number; vx: number; vy: number; size: number; life: number; color: string }
interface Popup { x: number; y: number; life: number; text: string; color: string; size: number }

const MAX_TICKS_PER_FRAME = 8;   // щоб просадка кадрів не перетворилась на спіраль
const RESULT_GRACE = 0.4;        // мін. затримка перед тим, як клік/пробіл по RESULT щось робить

/* Реальна сума за блок часто менша за 1 (payoutK великий відносно ставки) —
   округлення до цілого показувало б «+0» майже на кожному блоці, хоча
   насправді щось додається до виграшу. Тому показуємо дріб, а не ціле:
   "+0.04", "+0.4", і лише коли він справді нульовий (земля/камінь) — нічого. */
function fmtCash(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

export class Presenter {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private reel = new Reel();
  private raf = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  private state: State = 'LOADING';
  private message = 'завантаження…';
  private error: string | null = null;
  private busy = false;
  private resultEmpty = false;
  private verified: boolean | null = null;

  /* серверний стан, показуємо як є */
  private player: PlayerState | null = null;
  private balance = 0;
  private bet = 50;

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

  /* геометрія */
  private w = 0; private h = 0; private cell = 0;
  private fieldW = 0; private fieldX = 0;
  private itemW = 0; private itemH = 0;

  private onHud: (h: HudState) => void;
  private onResize = () => this.layout();
  private onKey = (e: KeyboardEvent) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    /* Затиснутий пробіл (ще з моменту старту прокруту) генерує браузером
       ПОВТОРНІ keydown з e.repeat=true, доки палець не відпустять. Кожен
       такий повтор під час SPIN/RUNNING нічого не робив (стан не IDLE),
       але щойно з'являвся RESULT, ПЕРШИЙ-ЛІПШИЙ повторний keydown після
       RESULT_GRACE одразу запускав новий раунд — виглядало як «прокрут
       сам собою». Ігноруємо повтори: реагуємо лише на СПРАВЖНє нове
       натискання. */
    if (e.repeat) return;
    this.primary();
  };
  private onClick = () => {
    if (this.state === 'RESULT') this.primary();
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
      this.message = 'Постав ставку і крути';
    } catch (e) {
      this.state = 'ERROR';
      this.error = e instanceof Error ? e.message : String(e);
      this.message = 'Сервер недоступний';
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
      this.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  };

  /* ---------------- ввід ---------------- */

  setBet(b: number): void {
    if (this.state !== 'IDLE' || this.busy) return;
    this.bet = b;
    this.emit();
  }

  /** Головна кнопка: завжди одразу новий раунд — навіть одразу після
      результату попереднього, без окремого проміжного кроку «далі».
      Мінімальна затримка (RESULT_GRACE) — щоб залишковий/затриманий клік
      чи утримана клавіша пробіл, що прилетіли ще з попереднього раунду,
      не запускали наступний АВТОМАТИЧНО, щойно з'явиться результат. */
  primary(): void {
    if (this.state === 'RESULT') {
      if (this.resultT < RESULT_GRACE) return;
      const bonus = !!this.player?.bonusPending;
      this.closeResult();
      if (bonus || this.balance >= this.bet) void this.startRound(bonus ? 'bonus-streak' : 'bet');
      return;
    }
    if (this.state !== 'IDLE' || this.busy) return;
    void this.startRound(this.player?.bonusPending ? 'bonus-streak' : 'bet');
  }

  buy(): void {
    if (this.state !== 'IDLE' || this.busy) return;
    void this.startRound('bonus-buy');
  }

  /* ---------------- раунд ---------------- */

  private applyPlayer(p: PlayerState): void {
    this.player = p;
    this.balance = p.balance;
    if (p.config?.bets?.length && !p.config.bets.includes(this.bet)) {
      this.bet = p.config.bets[Math.min(2, p.config.bets.length - 1)];
    }
  }

  private async startRound(mode: RoundMode): Promise<void> {
    this.busy = true;
    this.error = null;
    this.verified = null;
    this.message = 'запит на сервер…';
    this.emit();

    /* Ключ ідемпотентності живе на всю спробу, включно з ретраєм:
       у вебв'ю телеграма запит може дійти до сервера й обірватись
       на відповіді. З тим самим ключем сервер поверне вже зіграний
       раунд, а не спише ставку вдруге. */
    const key = roundKey();
    let res;
    try {
      res = await Api.play(this.bet, mode, key);
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
        res = await Api.play(this.bet, mode, key);
      } catch (e2) {
        this.busy = false;
        this.error = e2 instanceof ApiError ? e2.message : 'Сервер не відповів';
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
    this.setup = buildSetup(round.seed, round.mode);
    if (this.setup.spins.join() !== round.spins.join()
      || this.setup.tiers.join() !== round.tiers.join()
      || this.setup.startCols.join() !== round.startCols.join()) {
      this.verified = false;
      this.setup = { mode: round.mode, bonus: round.bonusMine, spins: round.spins,
                     tiers: round.tiers, startCols: round.startCols };
    }

    this.reel.bonusMode = round.mode !== 'bet';
    this.spinIndex = 0;
    this.shown = [];
    this.stageTarget = 0;
    this.resultT = 0;
    this.acc = 0;
    this.newMine(round.seed, round.bonusMine);
    this.nextSpin();
    this.emit();
  }

  private nextSpin(): void {
    const setup = this.setup!;
    const round = this.round!;
    const bonus = round.mode !== 'bet';

    if (this.spinIndex >= setup.spins.length) { this.launch(); return; }

    this.state = 'SPIN';
    this.message = bonus
      ? `БОНУС  ${this.spinIndex + 1} / ${CONFIG.bonus.spins}   кірок: ${this.shown.filter(Boolean).length}`
      : 'Крутимо…';
    this.emit();

    const id = setup.spins[this.spinIndex];
    const winner: ReelItem = id ? TIER_BY_ID[id] : null;
    const ms = bonus ? CONFIG.bonus.spinMs : CONFIG.reel.spinMs;
    const gap = bonus ? CONFIG.bonus.gapMs : CONFIG.reel.gapMs;

    this.reel.start(winner, (item) => {
      this.shown[this.spinIndex] = item;
      if (item) {
        this.flash = 0.25;
        this.flashColor = '#ffd34d';
        if (!bonus) {
          // звичайна ставка: перша ж кірка зупиняє прокрути
          this.tier = item;
          this.message = item.name + '! Пішли копати';
          this.state = 'RISE';
          this.stageTarget = 1;
          this.emit();
          this.wait(CONFIG.reel.riseMs / 1000, () => this.launch());
          return;
        }
      } else if (!bonus) {
        this.message = 'Пусто';
        this.emit();
      }
      this.wait(gap / 1000, () => { this.spinIndex++; this.nextSpin(); });
    }, ms);
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
      this.message = 'Кірок у шахту: ' + setup.tiers.length;
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
    this.message = `Глибина ${Math.floor(run.depth)}, блоків ${run.blocks}  →  +${round.payout}`;
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
      bonus: round.mode !== 'bet',
    });
    if (this.history.length > 12) this.history.pop();

    this.state = 'RESULT';
    this.resultT = 0;
    this.resultEmpty = round.payout === 0;
    const net = round.payout - round.cost;
    haptic(net >= 0 ? 'win' : 'lose');
    this.message = round.mode !== 'bet'
      ? 'БОНУСКА: +' + round.payout
      : round.bonusPending ? 'СТРІК ДОБИТО — БОНУСКА!'
      : net >= 0 ? 'ВИГРАШ +' + net : 'ПРОГРАШ ' + net;
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
      ? 'Мало монет — зменш ставку'
      : this.player?.bonusPending ? 'Бонуска чекає — тисни КРУТИТИ'
      : 'Постав ставку і крути';
    this.emit();
  }

  /* ---------------- шахта ---------------- */

  private newMine(seed: string, bonus: boolean): void {
    this.mine = new Mine(CONFIG.cols, streamRoot(seed, 'mine'), bonus);
    this.run = null;
    this.particles = [];
    this.popups = [];
    this.camY = this.camMin;
  }

  /* Фон під рулеткою. Ні на що не впливає, тому сид довільний. */
  private decorativeMine(): void {
    this.mine = new Mine(CONFIG.cols, (Math.random() * 0x7fffffff) | 0, false);
    this.run = null;
    this.particles = [];
    this.popups = [];
    this.camY = this.camMin;
  }

  /* ---------------- HUD ---------------- */

  private emit(): void {
    const p = this.player;
    const cfg = p?.config;
    const buyCost = this.bet * (cfg?.buyCost ?? CONFIG.bonus.buyCost);
    const idle = this.state === 'IDLE' && !this.busy;
    const pending = !!p?.bonusPending;

    this.onHud({
      state: this.state,
      balance: Math.round(this.balance),
      bet: this.bet,
      bets: cfg?.bets ?? [...CONFIG.bets],
      streak: p?.streak ?? 0,
      streakNeeded: p?.streakNeeded ?? CONFIG.bonus.streak,
      bonusPending: pending,
      buyCost,
      message: this.message,
      canSpin: (idle && (pending || this.balance >= this.bet)) || this.state === 'RESULT',
      canBuy: idle && this.balance >= buyCost && !pending,
      // кнопка завжди означає ОДНУ дію — новий раунд, тому напис однаковий
      // і в IDLE, і в RESULT (клік по результату одразу й крутить далі)
      spinLabel: pending ? 'БОНУСКА' : 'ГРАТИ  -' + this.bet,
      busy: this.busy,
      resultEmpty: this.resultEmpty,
      verified: this.verified,
      fair: this.round?.fair ?? (p ? { serverSeedHash: p.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce } : null),
      error: this.error,
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
            text: '+' + fmtCash(cash), color: BLOCKS[e.id].color, size: 0.2 });
        }
        this.shake = Math.min(14, this.shake + 3);
      } else if (e.t === 'mult') {
        this.burst(e.c + 0.5, e.r + 0.5, '#ffd34d', 44, 2.4);
        this.shake = 22;
        this.flash = 0.45; this.flashColor = '#ffd34d';
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.8,
          text: 'X' + e.m, color: '#ffe98a', size: 0.42 });
        haptic('hit');
      } else if (e.t === 'tnt') {
        this.burst(e.c + 0.5, e.r + 0.5, '#ff8a2b', 46, 3);
        let sum = 0;
        for (const h of e.hit) { this.burst(h.c + 0.5, h.r + 0.5, BLOCKS[h.id].color, 8); sum += BLOCKS[h.id].value; }
        const cash = sum * this.bet / CONFIG.payoutK;
        this.shake = 26;
        this.flash = 0.35; this.flashColor = '#ff7a2b';
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.3,
          text: cash > 0 ? 'БУМ! +' + fmtCash(cash) : 'БУМ!', color: '#ff8a2b', size: 0.26 });
      } else if (e.t === 'magic') {
        this.burst(e.c + 0.5, e.r + 0.5, '#c46bff', 40, 2.2);
        this.shake = 16;
        this.flash = 0.4; this.flashColor = '#c46bff';
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.6,
          text: 'ВЕРСТАК!', color: '#d9a3ff', size: 0.24 });
      } else if (e.t === 'pickdead') {
        this.burst(e.x, e.y, '#8a939f', 22, 1.4);
        this.shake = Math.max(this.shake, 12);
      }
    }
    r.events.length = 0;
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

    // квадратна комірка-символ, велика — рулетка тепер головний елемент
    // екрана, поки крутиться, тому їй віддано куди більше місця, ніж
    // раніше (був вузький список із п'ятьма рядками тексту)
    const R = CONFIG.reel;
    let ih = Math.max(90, Math.min(170, this.h / (R.visible + 1.5)));
    let iw = ih * R.widthRatio;
    const maxW = this.w - 56;
    if (iw > maxW) { iw = maxW; ih = iw / R.widthRatio; }
    this.itemH = ih;
    this.itemW = iw;

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

    // рулетка: у центрі, поки не випала кірка, далі їде вгору
    const a = 1 - this.stage;
    if (a > 0.01) {
      ctx.fillStyle = 'rgba(4,6,9,' + (0.62 * a).toFixed(3) + ')';
      ctx.fillRect(0, 0, this.w, this.h);
      const focusY = this.h * 0.46;
      const riseTo = -this.itemH * CONFIG.reel.visible;
      const cy = focusY + (riseTo - focusY) * this.stage;
      this.reel.draw(ctx, this.w / 2, cy, this.itemW, this.itemH, Math.min(1, a * 1.6));
      if (this.round && this.round.mode !== 'bet') {
        Render.text(ctx, 'БОНУСНА ГРА', this.w / 2, cy - this.itemH * CONFIG.reel.visible / 2 - 46,
          '800 26px ui-monospace, monospace', '#ffd34d');
      }
    }

    this.drawTrack(ctx);
    this.drawHistory(ctx);
    if (this.state === 'RESULT' && !this.resultEmpty) this.drawResult(ctx);
  }

  private get inBonus(): boolean { return !!this.round && this.round.mode !== 'bet'; }

  private drawSky(ctx: CanvasRenderingContext2D): void {
    const horizon = this.sy(0);
    const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
    g.addColorStop(0, this.inBonus ? '#5b3a8f' : '#4aa8f0');
    g.addColorStop(1, this.inBonus ? '#a97fe0' : '#9fd6ff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, Math.max(0, horizon));
    ctx.fillStyle = this.inBonus ? '#120a1c' : '#0a0c10';
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
      Render.text(ctx, p.text, this.sx(p.x), this.sy(p.y),
        '800 ' + Math.round(this.cell * p.size) + 'px ui-monospace, monospace', p.color);
    }
    ctx.globalAlpha = 1;
  }

  /* Стіни шахти по боках, якщо поле вужче за екран */
  private drawWalls(ctx: CanvasRenderingContext2D): void {
    if (this.fieldX <= 0) return;
    ctx.fillStyle = this.inBonus ? '#0d0716' : '#05070a';
    ctx.fillRect(0, 0, this.fieldX, this.h);
    ctx.fillRect(this.fieldX + this.fieldW, 0, this.fieldX + 2, this.h);
  }

  /* Доріжка спроб */
  private drawTrack(ctx: CanvasRenderingContext2D): void {
    // при одному прокруті на ставку доріжка з єдиного квадрата
    // нічого не додає — сама рулетка вже й є цей єдиний крок
    if (!this.round || !this.inBonus) return;
    const n = CONFIG.bonus.spins;
    const s = Math.min(40, (this.w - 40) / n - 7);
    const gap = Math.min(7, s * 0.18);
    const totalW = n * s + (n - 1) * gap;
    const x0 = (this.w - totalW) / 2;
    const y = 14;

    Render.panel(ctx, x0 - 10, y - 8, totalW + 20, s + 16, this.inBonus ? '#4a3560' : '#2c323b', 4);

    for (let i = 0; i < n; i++) {
      const x = x0 + i * (s + gap);
      const done = i < this.shown.length;
      const res = this.shown[i];
      const cur = i === this.spinIndex && this.state === 'SPIN';

      Render.inset(ctx, x, y, s, s, cur ? '#4a4433' : '#1b1f26', 3);
      if (done) {
        if (!res) Render.cross(ctx, x + s / 2, y + s / 2, s * 0.42, 0.9);
        else Render.pickaxe(ctx, x + s / 2, y + s / 2, s * 0.84, res, -0.5, false);
      }
      if (cur) {
        ctx.strokeStyle = '#ffd34d';
        ctx.lineWidth = 3;
        ctx.strokeRect(x + 1.5, y + 1.5, s - 3, s - 3);
      }
    }
  }

  /* Історія ставок — колонка зліва */
  private drawHistory(ctx: CanvasRenderingContext2D): void {
    if (this.w < 720 || !this.history.length) return;
    const w = 156, rh = 34, x = 14, y = 86;
    const n = Math.min(this.history.length, Math.max(2, Math.floor((this.h - y - 30) / rh) - 1));

    Render.panel(ctx, x, y, w, 26 + n * rh, '#2c323b', 4);
    Render.text(ctx, 'ОСТАННІ', x + w / 2, y + 18, '700 12px ui-monospace, monospace', '#b9c2ce');

    for (let i = 0; i < n; i++) {
      const e = this.history[i];
      const ry = y + 26 + i * rh;
      const won = e.win >= e.cost;
      Render.inset(ctx, x + 6, ry + 2, w - 12, rh - 5,
        e.bonus ? '#3a2b52' : (i === 0 ? '#1f2a22' : '#1b1f26'), 3);

      if (!e.item) Render.cross(ctx, x + 24, ry + rh / 2, 13, 0.85);
      else Render.pickaxe(ctx, x + 24, ry + rh / 2, 27, e.item, -0.5, false);
      if (e.bonus) {
        Render.text(ctx, 'B', x + 40, ry + rh / 2 + 5,
          '800 11px ui-monospace, monospace', '#d9a3ff', 'left');
      }

      Render.text(ctx, 'x' + e.x.toFixed(2), x + w - 12, ry + rh / 2 + 5,
        '700 14px ui-monospace, monospace',
        e.win === 0 ? '#7a8595' : (won ? '#5ce08a' : '#e0925c'), 'right');
    }
  }


  private drawResult(ctx: CanvasRenderingContext2D): void {
    const round = this.round;
    if (!round) return;
    const a = Math.min(1, this.resultT * 3);
    const bw = Math.min(420, this.w - 40), bh = 176;
    const bx = (this.w - bw) / 2, by = this.h / 2 - bh / 2;
    ctx.globalAlpha = a;

    const bonusRun = round.mode !== 'bet';
    Render.panel(ctx, bx, by, bw, bh, bonusRun ? '#4a3560' : '#2c323b', 5);
    const mid = bx + bw / 2;
    const spent = round.cost || round.bet;
    const net = round.payout - round.cost;

    Render.text(ctx, bonusRun
      ? `БОНУСКА  ·  КІРОК ${round.tiers.length}  ·  ${round.mode === 'bonus-buy' ? 'КУПЛЕНА' : 'ЗА СТРІК'}`
      : `СТАВКА ${round.bet}`,
      mid, by + 30, '700 13px ui-monospace, monospace', '#c8b4e0');

    Render.text(ctx, '+' + Math.round(round.payout), mid, by + 84,
      '800 46px ui-monospace, monospace', net >= 0 ? '#5ce08a' : '#e05c5c');

    const first = round.tiers.length ? TIER_BY_ID[round.tiers[0]] : null;
    if (round.capped) {
      Render.text(ctx, 'СТЕЛЯ ВИГРАШУ x' + CONFIG.maxWinX, mid, by + 116,
        '800 15px ui-monospace, monospace', '#ffd34d');
    } else {
      Render.text(ctx, bonusRun
        ? `множник X${round.sim.multChain}  ·  x${(round.payout / spent).toFixed(2)}`
        : (first ? `${first.name}  ·  x${(round.payout / spent).toFixed(2)}`
                 : 'кірка не випала — ставка згоріла'),
        mid, by + 116, '700 13px ui-monospace, monospace', '#9aa4b2');
    }

    Render.text(ctx, round.bonusPending && round.mode === 'bet'
      ? 'далі — БОНУСНА ГРА' : 'клік або пробіл — далі',
      mid, by + 152, '700 12px ui-monospace, monospace',
      round.bonusPending && round.mode === 'bet' ? '#ffd34d' : '#7a8595');
    ctx.globalAlpha = 1;
  }
}
