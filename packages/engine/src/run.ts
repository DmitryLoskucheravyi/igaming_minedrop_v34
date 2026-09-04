/* ============================================================
   RUN — фізика забігу. Чиста логіка, без малювання:
   клієнт її рендерить, сервер ганяє до кінця в одному циклі,
   sim/*.ts — тисячами.

   У звичайній грі кірка одна. У бонусній їх кілька і вони
   копають ОДНОЧАСНО в одній шахті, складаючи очки в спільний
   рахунок.

   Кірка падає, б'є блок, ВІДСКАКУЄ вбік і перевертається,
   тому летить по діагоналі, а не тупо вниз.

   Земля, камінь і динаміт падають з одного удару. Руда має
   міцність (BLOCKS[id].tough) — кірка знімає свій dmg за удар,
   тріщини наростають, очки дає тільки повний розкол.

   Блок-множник множить УЖЕ НАКОПИЧЕНИЙ виграш. Очки, зароблені
   після нього, цим множником не іксуються — тільки наступними.

   ДЕТЕРМІНІЗМ: крок завжди SIM_DT. tick() не приймає dt зовні —
   саме через це сервер і клієнт отримують однакову траєкторію.
   ============================================================ */

import { BLOCKS, CONFIG, SIM_DT, TIERS, tierIndex } from './config';
import type { Rng } from './rng';
import { isWall, Mine, type Cell } from './world';
import type { RunEndReason, RunEvent, Tier, TierId } from './types';

const P = CONFIG.phys;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/* ---- прибирання шахти ----
   Ряди, які лишились позаду, викидаються, щоб пам'ять не росла.
   Але викинути ряд = ЗАБУТИ його стан: тріщини обнуляться, а розбиті
   блоки повернуться цілими, бо генерація порядкова і відтворить ряд
   з нуля. Тому пруном керує сам рушій, а не той, хто його малює.

   Межа рахується від НАЙВИЩОЇ ЖИВОЇ кірки, а не від найглибшої.
   У бонусці кірок 11, вони розтягуються на сотні рядів, і межа за
   найглибшою зрізала б ряди, в яких відсталі ще копають. Саме на
   цьому клієнт розходився з сервером.

   Запас 24 ряди — з великим перебором: найсильніший підкид (TNT,
   6 клітинок/с проти гравітації 33) піднімає кірку менш ніж на
   одну клітинку. */
const PRUNE_MARGIN = 24;
const PRUNE_EVERY = 60;   // кроків між прибираннями

/* TNT: скільки твердих блоків рознести за один вибух — випадково
   в цьому діапазоні, замість завжди всього доступного квадрата. */
const TNT_MIN_HITS = 3;
const TNT_MAX_HITS = 6;

/* Одна кірка — тіло у фізиці */
export class Pick {
  level: number;
  tier: Tier;
  hpMax: number;
  hp: number;
  enchanted = false;

  x: number;
  y: number;
  vx = 0;
  vy = 0;
  rot = -0.5;
  rotV = 0;

  blocks = 0;
  hits = 0;
  depth = 0;
  dead = false;
  lastHitKey: string | null = null;
  lastHitT = -1;

  constructor(tier: Tier, col: number, y0: number) {
    this.level = tierIndex(tier.id);
    this.tier = tier;
    this.hpMax = tier.hp;
    this.hp = tier.hp;
    this.x = col + 0.5;
    this.y = y0;
  }
}

export interface RunOptions {
  /** з яких колонок стартують кірки — приходить із RoundResult */
  cols: number[];
  /** потік випадковості фізики (окремий від шахти й рулетки) */
  rnd: Rng;
}

export class Run {
  readonly mine: Mine;
  readonly bonus: boolean;
  readonly picks: Pick[];
  private readonly rnd: Rng;

  collected = 0;        // спільний рахунок усіх кірок
  multChain = 1;        // добуток усіх зібраних множників (для показу)
  blocks = 0;
  hits = 0;
  depth = 0;
  upgrades = 0;
  tnts = 0;
  mults = 0;
  time = 0;
  steps = 0;
  over = false;
  reason: RunEndReason | null = null;
  events: RunEvent[] = [];   // клієнт їх вичитує на партикли/тряску

  private pruneIn = PRUNE_EVERY;

  constructor(tiers: Tier[], mine: Mine, opts: RunOptions) {
    this.mine = mine;
    this.bonus = mine.bonus;
    this.rnd = opts.rnd;
    this.picks = tiers.map((t, i) =>
      new Pick(t, opts.cols[i % opts.cols.length], -P.startHeight - i * CONFIG.bonus.spread));
  }

  get alive(): Pick[] { return this.picks.filter((p) => !p.dead); }

  /* Виплата без стелі — потрібна, щоб знати, чи стеля спрацювала */
  rawPayout(bet: number): number { return Math.round(this.collected * bet / CONFIG.payoutK); }

  payout(bet: number): number { return Math.min(this.rawPayout(bet), bet * CONFIG.maxWinX); }

  /* Стеля зрізала виграш? Тоді UI мусить це сказати, інакше показаний
     множник не сходиться з виплатою і виглядає як обман. */
  isCapped(bet: number): boolean { return this.rawPayout(bet) > bet * CONFIG.maxWinX; }

  /* ---------------- крок симуляції ----------------
     Рівно SIM_DT. Клієнт накопичує реальний час і викликає tick()
     стільки разів, скільки набігло. */
  tick(): void {
    if (this.over) return;
    const dt = SIM_DT;
    this.time += dt;
    this.steps++;

    for (const p of this.picks) {
      if (p.dead) continue;
      this.stepPick(p, dt);
      if (this.over) break;
    }

    let deepest = this.depth;
    for (const p of this.picks) if (p.depth > deepest) deepest = p.depth;
    this.depth = deepest;

    if (this.picks.every((p) => p.dead)) this.finish('broken');
    else if (this.time > 240) this.finish('timeout');

    if (--this.pruneIn <= 0) { this.pruneIn = PRUNE_EVERY; this.pruneMine(); }
  }

  /* Викидаємо тільки те, до чого вже точно не дотягнеться жодна жива кірка. */
  private pruneMine(): void {
    let top = Infinity;
    for (const p of this.picks) if (!p.dead && p.y < top) top = p.y;
    if (!Number.isFinite(top)) return;
    this.mine.prune(Math.floor(top) - PRUNE_MARGIN);
  }

  /** Догнати забіг до кінця — сервер і симуляції */
  runToEnd(): this {
    let guard = 0;
    while (!this.over && guard++ < P.maxSteps) {
      this.events.length = 0;
      this.tick();
    }
    if (!this.over) this.finish('limit');
    return this;
  }

  private stepPick(p: Pick, dt: number): void {
    p.vy = Math.min(P.maxFall, p.vy + P.gravity * dt);
    p.vx -= p.vx * P.airDrag * dt;
    p.rot += p.rotV * dt;
    p.rotV -= p.rotV * P.spinDamp * dt;

    const dist = Math.hypot(p.vx, p.vy) * dt;
    const n = Math.max(1, Math.ceil(dist / P.substep));
    const sdt = dt / n;

    for (let i = 0; i < n && !p.dead; i++) {
      p.x += p.vx * sdt;
      p.y += p.vy * sdt;
      this.collide(p);
    }
    if (p.y > p.depth) p.depth = p.y;
  }

  private collide(p: Pick): void {
    const R = P.bodyR;

    // бічні стінки шахти
    if (p.x < R) { p.x = R; p.vx = Math.abs(p.vx) * P.wallBounce; }
    else if (p.x > this.mine.cols - R) { p.x = this.mine.cols - R; p.vx = -Math.abs(p.vx) * P.wallBounce; }

    // б'ємо тим боком, у який летимо
    const sp = Math.hypot(p.vx, p.vy);
    const nx = sp > 0.001 ? p.vx / sp : 0;
    const ny = sp > 0.001 ? p.vy / sp : 1;
    const c = Math.floor(p.x + nx * R);
    const r = Math.floor(p.y + ny * R);

    const cell = this.mine.get(r, c);
    if (!cell || isWall(cell)) return;
    this.impact(p, r, c, cell);
  }

  private impact(p: Pick, r: number, c: number, cell: Cell): void {
    // не даємо зарахувати кілька ударів по одній клітинці за мить
    const key = r + ',' + c;
    if (key === p.lastHitKey && this.time - p.lastHitT < P.hitCooldown) return;
    p.lastHitKey = key;
    p.lastHitT = this.time;

    const def = BLOCKS[cell.id];
    const idx = this.picks.indexOf(p);
    const dx = p.x - (c + 0.5);
    const dy = p.y - (r + 0.5);
    const sideways = Math.abs(dx) > Math.abs(dy);

    if (def.kind === 'magic') {
      this.mine.clear(r, c);
      if (p.level < TIERS.length - 1) { p.level++; p.tier = TIERS[p.level]; }
      p.enchanted = true;
      p.hpMax = p.tier.hp;
      p.hp = p.tier.hp;
      this.upgrades++;
      this.events.push({ t: 'magic', r, c, tier: p.tier.id as TierId, pick: idx });
      this.bounce(p, dx, sideways, 0.7);
      return;
    }

    if (def.kind === 'mult') {
      this.mine.clear(r, c);
      const m = cell.m || 2;
      const before = this.collected;
      p.hp -= def.cost;
      p.hits++; this.hits++;
      this.collected *= m;              // множить УЖЕ накопичений виграш
      this.multChain *= m;
      this.mults++;
      this.events.push({ t: 'mult', r, c, m, before, total: this.collected, pick: idx });
      this.bounce(p, dx, sideways, 1);
      this.checkDead(p, idx);
      return;
    }

    if (def.kind === 'tnt') {
      this.mine.clear(r, c);
      p.hp -= def.cost;
      p.hits++; this.hits++;
      this.tnts++;

      /* Вибух хаотичний, не фіксований квадратом: з усіх твердих
         блоків у сусідній 3x3-клітинці випадково розноситься від
         TNT_MIN_HITS до TNT_MAX_HITS штук, а не завжди всі до восьми.
         Порядок перемішується тим самим потоком фізики, що й
         відскоки, — тому детермінізм не ламається: клієнт відтворює
         рівно ті самі блоки, що й сервер. */
      const candidates: { r: number; c: number; id: Cell['id'] }[] = [];
      for (let rr = r - 1; rr <= r + 1; rr++) {
        for (let cc = c - 1; cc <= c + 1; cc++) {
          if (rr === r && cc === c) continue;
          const b = this.mine.get(rr, cc);
          if (!b || isWall(b)) continue;
          if (BLOCKS[b.id].kind !== 'solid') continue;   // TNT / верстак / множник не чіпаємо
          candidates.push({ r: rr, c: cc, id: b.id });
        }
      }
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(this.rnd() * (i + 1));
        const tmp = candidates[i]; candidates[i] = candidates[j]; candidates[j] = tmp;
      }
      const count = Math.min(candidates.length,
        TNT_MIN_HITS + Math.floor(this.rnd() * (TNT_MAX_HITS - TNT_MIN_HITS + 1)));

      const hit: { r: number; c: number; id: Cell['id'] }[] = [];
      for (let i = 0; i < count; i++) {
        const b = candidates[i];
        this.mine.clear(b.r, b.c);                       // вибух розносить одразу, без ударів
        this.collected += BLOCKS[b.id].value;
        this.blocks++; p.blocks++;
        hit.push(b);
      }

      this.events.push({ t: 'tnt', r, c, hit, pick: idx });
      p.vy = -P.tntBlast;
      p.vx = clamp(p.vx + (this.rnd() - 0.5) * P.tntBlast, -P.maxSideSpeed, P.maxSideSpeed);
      p.rotV += (this.rnd() < 0.5 ? -1 : 1) * P.spinKick * 1.6;
      this.checkDead(p, idx);
      return;
    }

    /* звичайний блок: кірка знімає свій урон.
       Земля/камінь мають tough 1 — падають з першого удару будь-якою кіркою.
       Руда міцніша, і чим краща кірка, тим менше ударів на неї треба. */
    p.hp -= def.cost;
    p.hits++; this.hits++;
    cell.dmg += p.tier.dmg;

    if (cell.dmg >= def.tough) {
      this.mine.clear(r, c);
      this.collected += def.value;
      this.blocks++; p.blocks++;
      this.events.push({ t: 'break', r, c, id: def.id, got: def.value, pick: idx });
    } else {
      this.events.push({ t: 'crack', r, c, id: def.id, stage: cell.dmg, of: def.tough, pick: idx });
    }

    this.bounce(p, dx, sideways, 1);
    this.checkDead(p, idx);
  }

  /* Відскок + перевертання. Саме звідси береться діагональ. */
  private bounce(p: Pick, dx: number, sideways: boolean, k: number): void {
    const dir = dx === 0 ? (this.rnd() < 0.5 ? -1 : 1) : Math.sign(dx);

    if (sideways) {
      p.vx = dir * (Math.abs(p.vx) * P.restitution + P.sideKick) * k;
      p.vy *= 0.55;
    } else {
      p.vy = -(Math.abs(p.vy) * P.restitution + P.bounceKick) * k;
      p.vx += dir * (P.sideKick * 0.5 + this.rnd() * P.sideKickRand) * k;
    }

    p.vx = clamp(p.vx, -P.maxSideSpeed, P.maxSideSpeed);
    p.rotV += (this.rnd() < 0.5 ? -1 : 1) * (P.spinKick * (0.6 + this.rnd() * 0.8));
  }

  private checkDead(p: Pick, idx: number): void {
    if (p.hp <= 0) {
      p.hp = 0;
      p.dead = true;
      this.events.push({ t: 'pickdead', x: p.x, y: p.y, tier: p.tier.id as TierId, pick: idx });
    }
    if (this.hits >= P.maxHits * this.picks.length) this.finish('limit');
  }

  private finish(reason: RunEndReason): void {
    if (this.over) return;
    this.over = true;
    this.reason = reason;
    this.events.push({ t: 'end', reason });
  }
}
