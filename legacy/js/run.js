/* ============================================================
   RUN — фізика забігу. Чиста логіка, без малювання:
   game.js її рендерить, sim/*.js ганяє тисячами в node.

   У звичайній грі кірка одна. У бонусній їх кілька і вони
   копають ОДНОЧАСНО в одній шахті, складаючи гроші в спільний
   рахунок.

   Кірка падає, б'є блок, ВІДСКАКУЄ вбік і перевертається,
   тому летить по діагоналі, а не тупо вниз.

   Земля, камінь і динаміт падають з одного удару. Руда має
   міцність (BLOCKS[id].tough) — кірка знімає свій dmg за удар,
   тріщини наростають, гроші дає тільки повний розкол.

   Блок-множник (тільки в бонусці) множить УЖЕ НАКОПИЧЕНИЙ
   виграш. Гроші, зароблені після нього, цим множником не
   іксуються — тільки наступними.
   ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined') {
    const c = require('./config.js');
    module.exports = factory(c.CONFIG, c.TIERS, c.BLOCKS, require('./world.js'));
  } else {
    root.Run = factory(CONFIG, TIERS, BLOCKS, World);
  }
})(typeof self !== 'undefined' ? self : this, function (CONFIG, TIERS, BLOCKS, World) {

  const P = CONFIG.phys;
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

  /* Одна кірка — тіло у фізиці */
  class Pick {
    constructor(tier, col, y0) {
      this.level = TIERS.indexOf(tier);
      this.tier = tier;
      this.hpMax = tier.hp;
      this.hp = tier.hp;
      this.enchanted = false;

      this.x = col + 0.5;
      this.y = y0;
      this.vx = 0;
      this.vy = 0;
      this.rot = -0.5;
      this.rotV = 0;

      this.blocks = 0;
      this.hits = 0;
      this.depth = 0;
      this.dead = false;
      this.lastHitKey = null;
      this.lastHitT = -1;
    }
  }

  class Run {
    /* tiers — кірка або масив кірок. opts: { cols, rnd } */
    constructor(tiers, mine, opts) {
      opts = opts || {};
      this.rnd = opts.rnd || Math.random;
      this.mine = mine;
      this.bonus = !!mine.bonus;

      const list = Array.isArray(tiers) ? tiers : [tiers];
      const cols = opts.cols || this.spreadCols(list.length, mine.cols);
      this.picks = list.map((t, i) =>
        new Pick(t, cols[i % cols.length], -P.startHeight - i * CONFIG.bonus.spread));

      this.collected = 0;      // спільний рахунок усіх кірок
      this.multChain = 1;      // добуток усіх зібраних множників (для показу)
      this.blocks = 0;
      this.hits = 0;
      this.depth = 0;
      this.upgrades = 0;
      this.tnts = 0;
      this.mults = 0;
      this.time = 0;
      this.over = false;
      this.reason = null;
      this.events = [];        // game.js їх вичитує на партикли/тряску
    }

    /* Рознести старти по різних колонках */
    spreadCols(n, cols) {
      const all = [];
      for (let i = 0; i < cols; i++) all.push(i);
      for (let i = all.length - 1; i > 0; i--) {      // перемішуємо
        const j = Math.floor(this.rnd() * (i + 1));
        const t = all[i]; all[i] = all[j]; all[j] = t;
      }
      const out = [];
      for (let i = 0; i < n; i++) out.push(all[i % cols]);
      return out;
    }

    get alive() { return this.picks.filter(p => !p.dead); }

    /* Виплата без стелі — потрібна, щоб знати, чи стеля спрацювала */
    rawPayout(bet) { return Math.round(this.collected * bet / CONFIG.payoutK); }

    payout(bet) { return Math.min(this.rawPayout(bet), bet * CONFIG.maxWinX); }

    /* Стеля зрізала виграш? Тоді UI мусить це сказати, інакше показаний
       множник не сходиться з виплатою і виглядає як обман. */
    isCapped(bet) { return this.rawPayout(bet) > bet * CONFIG.maxWinX; }

    /* ---------------- крок симуляції ---------------- */
    step(dt) {
      if (this.over) return;
      this.time += dt;

      for (const p of this.picks) {
        if (p.dead) continue;
        this.stepPick(p, dt);
        if (this.over) break;
      }

      let deepest = this.depth;
      for (const p of this.picks) if (p.depth > deepest) deepest = p.depth;
      this.depth = deepest;

      if (this.picks.every(p => p.dead)) this.finish('broken');
      else if (this.time > 240) this.finish('timeout');
    }

    stepPick(p, dt) {
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

    collide(p) {
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
      if (!cell || cell === World.WALL) return;
      this.impact(p, r, c, cell);
    }

    impact(p, r, c, cell) {
      // не даємо зарахувати кілька ударів по одній клітинці за мить
      const key = r + ',' + c;
      if (key === p.lastHitKey && this.time - p.lastHitT < P.hitCooldown) return;
      p.lastHitKey = key;
      p.lastHitT = this.time;

      const def = BLOCKS[cell.id];
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
        this.events.push({ t: 'magic', r, c, tier: p.tier.id });
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
        this.events.push({ t: 'mult', r, c, m, before, total: this.collected });
        this.bounce(p, dx, sideways, 1);
        this.checkDead(p);
        return;
      }

      if (def.kind === 'tnt') {
        this.mine.clear(r, c);
        p.hp -= def.cost;
        p.hits++; this.hits++;
        this.tnts++;
        const hit = [];
        for (let rr = r - 1; rr <= r + 1; rr++) {
          for (let cc = c - 1; cc <= c + 1; cc++) {
            if (rr === r && cc === c) continue;
            const b = this.mine.get(rr, cc);
            if (!b || b === World.WALL) continue;
            if (BLOCKS[b.id].kind !== 'solid') continue;   // TNT / верстак / множник не чіпаємо
            this.mine.clear(rr, cc);                       // вибух розносить одразу, без ударів
            this.collected += BLOCKS[b.id].value;
            this.blocks++; p.blocks++;
            hit.push({ r: rr, c: cc, id: b.id });
          }
        }
        this.events.push({ t: 'tnt', r, c, hit });
        p.vy = -P.tntBlast;
        p.vx = clamp(p.vx + (this.rnd() - 0.5) * P.tntBlast, -P.maxSideSpeed, P.maxSideSpeed);
        p.rotV += (this.rnd() < 0.5 ? -1 : 1) * P.spinKick * 1.6;
        this.checkDead(p);
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
        this.events.push({ t: 'break', r, c, id: def.id, got: def.value });
      } else {
        this.events.push({ t: 'crack', r, c, id: def.id, stage: cell.dmg, of: def.tough });
      }

      this.bounce(p, dx, sideways, 1);
      this.checkDead(p);
    }

    /* Відскок + перевертання. Саме звідси береться діагональ. */
    bounce(p, dx, sideways, k) {
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

    checkDead(p) {
      if (p.hp <= 0) {
        p.hp = 0;
        p.dead = true;
        this.events.push({ t: 'pickdead', x: p.x, y: p.y, tier: p.tier.id });
      }
      if (this.hits >= P.maxHits * this.picks.length) this.finish('limit');
    }

    finish(reason) {
      if (this.over) return;
      this.over = true;
      this.reason = reason;
      this.events.push({ t: 'end', reason });
    }
  }

  Run.Pick = Pick;
  return Run;
});
