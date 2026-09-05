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

/* TNT: вибух — не статична фігура (квадрат) і не рівномірний розкид по
   ньому, а ПРОМЕНІ з епіцентру в випадкових напрямках (як у Minecraft):
   кожен промінь має свою "потужність", яка гасне по дорозі — тому форма
   виходить органічною випуклістю, різною щоразу, з нерівними краями,
   а не рівним колом чи квадратом. TNT_RAYS — скільки променів пускати;
   TNT_POWER_MIN/MAX — стартова потужність променя; TNT_STEP — крок
   променя в клітинках; TNT_DECAY_MIN/RAND — на скільки потужність
   гасне за крок. TNT_MAX_HITS лишається жорсткою стелею (безпека і
   узгодженість з інваріантом у sim/smoke.ts), якщо променів випадково
   зійшлось забагато. */
export const TNT_RAYS = 9;         // було 14 — вибух менший за проханням
export const TNT_POWER_MIN = 1.6;  // було 2.4
export const TNT_POWER_MAX = 3.0;  // було 4.4
export const TNT_STEP = 0.4;
export const TNT_DECAY_MIN = 0.3;
export const TNT_DECAY_RAND = 0.25;
export const TNT_MAX_HITS = 28;    // стеля НА ОДНУ ланку ланцюга (див. impact());
                                    // ланцюгова детонація сусіднього TNT може дати
                                    // більше сумарно — це вже не одна вибухівка

/* Стеля ЛАНЦЮГА множників за один забіг. Без неї collected множиться
   БЕЗ ОБМЕЖЕНЬ кожним наступним блоком-множником (x2..x15) — і саме
   через рідкісні довгі ланцюги середнє значення collected вибухає в
   мільйони/мільярди, змушуючи payoutK бути астрономічним числом, щоб
   утримати РТП=95%. А з таким payoutK будь-який окремий блок (навіть
   алмаз) при типовій ставці округлюється до нуля — «числа на екрані»
   перестають щось значити. Зі стелею довгий ланцюг усе одно рідкісний
   і приємний (до цього значення можна дійти кількома множниками), але
   вже не тягне середнє в нескінченність — payoutK можна тримати
   людяним числом, і звичайний блок знову щось важить. */
export const MULT_CHAIN_CAP = 50;

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

    /* Позиція кожної кірки, яка ОБРОБЛЯЛАСЬ цього тіку — жива на вході,
       навіть якщо саме цим кроком і померла. Пруниться нижче по НІЙ, а
       не по «живих зараз»: інакше кірка, що вмирає рівно від удару
       (наприклад, TNT забирає багато HP і саме це вбиває), випадає зі
       списку живих ДО pruneMine() у цьому ж тіку — і якщо інша кірка
       вже глибша за поточну позицію мертвої на PRUNE_MARGIN, ряд із
       щойно згенерованою подією (той-таки TNT) прибирається негайно.
       Клітинка потім регенерується наново (детерміновано, з того самого
       сида) — і на місці порожньої після вибуху клітинки знову
       з'являється блок. Особливо ймовірно тепер, коли TNT рознощить
       значно більше блоків і забіги стали довшими. */
    let touchedTop = Infinity;
    for (const p of this.picks) {
      if (p.dead) continue;
      this.stepPick(p, dt);
      if (p.y < touchedTop) touchedTop = p.y;
      if (this.over) break;
    }

    let deepest = this.depth;
    for (const p of this.picks) if (p.depth > deepest) deepest = p.depth;
    this.depth = deepest;

    if (this.picks.every((p) => p.dead)) this.finish('broken');
    else if (this.time > 240) this.finish('timeout');

    if (--this.pruneIn <= 0) { this.pruneIn = PRUNE_EVERY; this.pruneMine(touchedTop); }
  }

  /* Викидаємо тільки те, до чого вже точно не дотягнеться жодна жива кірка.
     touchedTop — від tick(): позиції кірок, ОБРОБЛЕНИХ цього тіку (тобто
     тих, чиї події могли щойно потрапити в run.events), а не переобчислення
     «хто живий зараз» — див. коментар у tick(). */
  private pruneMine(touchedTop: number): void {
    if (!Number.isFinite(touchedTop)) return;
    this.mine.prune(Math.floor(touchedTop) - PRUNE_MARGIN);
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

    /* Колізія — не одна точка попереду по вектору швидкості (тоді
       ручка, що стирчить збоку чи позаду напрямку польоту, могла
       пройти крізь блок без дотику), а все тіло кірки: коло радіусом R
       навколо центру. Перевіряємо всі клітинки в 3x3 навколо центру —
       чи їхня найближча точка ближче за R — і б'ємо найближчу тверду,
       незалежно від того, з якого боку вона торкнулась. */
    const cx = Math.floor(p.x), cy = Math.floor(p.y);
    let best: { r: number; c: number; cell: Cell } | null = null;
    let bestDist = Infinity;
    for (let rr = cy - 1; rr <= cy + 1; rr++) {
      for (let cc = cx - 1; cc <= cx + 1; cc++) {
        const cell = this.mine.get(rr, cc);
        if (!cell || isWall(cell)) continue;
        const nx = clamp(p.x, cc, cc + 1);
        const ny = clamp(p.y, rr, rr + 1);
        const d = Math.hypot(p.x - nx, p.y - ny);
        if (d < R && d < bestDist) { bestDist = d; best = { r: rr, c: cc, cell }; }
      }
    }
    if (!best) return;
    this.impact(p, best.r, best.c, best.cell);
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
      /* Апгрейд і повний хіл — лише поки є куди рости. На максимальному
         рівні (Diamond) верстак просто ламається без ефекту: інакше
         кірка на топ-тірі отримувала БЕЗКІНЕЧНИЙ безкоштовний хіл від
         кожного наступного верстака — у бонусці з кількома кірками й
         240-секундним лімітом часу це робило кірку практично безсмертною,
         і виграш майже завжди впирався у стелю maxWinX (98% бонусок),
         замість того щоб бути «шансом». */
      if (p.level < TIERS.length - 1) {
        p.level++;
        p.tier = TIERS[p.level];
        p.enchanted = true;
        p.hpMax = p.tier.hp;
        p.hp = p.tier.hp;
        this.upgrades++;
        this.events.push({ t: 'magic', r, c, tier: p.tier.id as TierId, pick: idx });
      }
      this.bounce(p, dx, sideways, 0.7);
      return;
    }

    if (def.kind === 'mult') {
      this.mine.clear(r, c);
      const m = cell.m || 2;
      const before = this.collected;
      p.hp -= def.cost;
      p.hits++; this.hits++;
      this.mults++;
      // ланцюг уже впирався в стелю — блок і так зникає, але вже не множить
      if (this.multChain < MULT_CHAIN_CAP) {
        this.collected *= m;            // множить УЖЕ накопичений виграш
        this.multChain *= m;
      }
      this.events.push({ t: 'mult', r, c, m, before, total: this.collected, pick: idx });
      this.bounce(p, dx, sideways, 1);
      this.checkDead(p, idx);
      return;
    }

    if (def.kind === 'tnt') {
      this.mine.clear(r, c);
      p.hp -= def.cost;
      p.hits++; this.hits++;

      /* Вибух — ПРОМЕНІ з епіцентру в випадкових напрямках (як у Minecraft),
         не статична фігура і не рівномірний розкид по квадрату. Кожен
         промінь летить, доки не згасне його потужність, руйнуючи тверді
         блоки й верстаки по дорозі — форма виходить органічною випуклістю,
         щоразу іншою.
         ЛАНЦЮГОВА ДЕТОНАЦІЯ: якщо промінь зачепив інший TNT, той теж
         вибухає — від СВОЄЇ позиції, своїми променями, і так само може
         зачепити наступний. `cleared` — спільний набір уже знищених
         клітинок на весь ланцюг (щоб один блок не порахувався двічі
         й пізніший вибух не бив по вже порожньому місцю), `queue` —
         черга позицій, які ще мають вибухнути. chainGuard — запобіжник
         від нескінченного ланцюга в дуже щільному TNT-регіоні.
         Верстак у вибуху ЛАМАЄТЬСЯ (як і просили), але апгрейд і повне
         відновлення HP дає лише ПРЯМИЙ дотик кірки (магічна гілка вище) —
         інакше кірка в бонусці ставала практично безсмертною.
         Детермінізм не ламається: увесь випадок — з того самого потоку
         фізики this.rnd(), клієнт відтворює рівно ту саму форму. */
      const cleared = new Set<string>([r + ',' + c]);
      const queue: [number, number][] = [[r, c]];
      let chainGuard = 0;

      while (queue.length && chainGuard++ < 60) {
        const [er, ec] = queue.shift()!;
        this.tnts++;

        const hitMap = new Map<string, { r: number; c: number; id: Cell['id'] }>();
        for (let i = 0; i < TNT_RAYS; i++) {
          const angle = this.rnd() * Math.PI * 2;
          const dx = Math.cos(angle), dy = Math.sin(angle);
          let power = TNT_POWER_MIN + this.rnd() * (TNT_POWER_MAX - TNT_POWER_MIN);
          let x = ec + 0.5, y = er + 0.5;
          while (power > 0) {
            x += dx * TNT_STEP;
            y += dy * TNT_STEP;
            power -= TNT_DECAY_MIN + this.rnd() * TNT_DECAY_RAND;
            const rr = Math.floor(y), cc = Math.floor(x);
            const key = rr + ',' + cc;
            if (cleared.has(key) || hitMap.has(key)) continue;
            const b = this.mine.get(rr, cc);
            if (!b || isWall(b)) continue;
            const k = BLOCKS[b.id].kind;
            if (k !== 'solid' && k !== 'magic' && k !== 'tnt') continue;
            hitMap.set(key, { r: rr, c: cc, id: b.id });
          }
        }
        let candidates = Array.from(hitMap.values());
        if (candidates.length > TNT_MAX_HITS) {
          for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(this.rnd() * (i + 1));
            const tmp = candidates[i]; candidates[i] = candidates[j]; candidates[j] = tmp;
          }
          candidates = candidates.slice(0, TNT_MAX_HITS);
        }

        const hit: { r: number; c: number; id: Cell['id'] }[] = [];
        for (const b of candidates) {
          cleared.add(b.r + ',' + b.c);
          this.mine.clear(b.r, b.c);                       // вибух розносить одразу, без ударів
          hit.push(b);
          this.blocks++; p.blocks++;
          if (BLOCKS[b.id].kind === 'tnt') queue.push([b.r, b.c]);
          else this.collected += BLOCKS[b.id].value;       // верстак: value 0, просто ламається
        }

        this.events.push({ t: 'tnt', r: er, c: ec, hit, pick: idx });
      }

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
