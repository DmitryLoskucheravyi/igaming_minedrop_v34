/* ============================================================
   GAME — стани, камера, ввід, рендер.

   ЗВИЧАЙНА СТАВКА: до CONFIG.spinsPerBet (7) прокрутів рулетки.
   Це 7 ШАНСІВ на кірку: перша ж кірка зупиняє прокрути,
   рулетка їде вгору, поле піднімається — і йде гра.

   БОНУСКА: вмикається, коли кірка випала CONFIG.bonus.streak
   ставок ПІДРЯД, або купується за CONFIG.bonus.buyCost ставок.
   Спрацювала на стріку — НЕ перериває поточну ставку: та
   догравається до кінця, і бонуска стартує після неї.
   Рулетка сама крутить 15 разів, і скільки кірок випало —
   стільки й падає в шахту ОДНОЧАСНО. Там є блоки-множники.

   IDLE -> SPIN -> RISE -> RUNNING -> DROPDONE -> RESULT -> IDLE
                                                     \-> BSPIN -> RUNNING -> RESULT
   ============================================================ */
const Game = {
  state: 'LOADING',
  balance: CONFIG.startBalance,
  bet: 50,
  mine: null,
  run: null,
  tier: null,

  spinIndex: 0,
  results: [],
  betWin: 0,
  history: [],          // останні ставки — панель збоку

  streak: 0,            // скільки ставок підряд випадала кірка
  bonusPending: false,  // бонуску виграно, стартує після поточної ставки
  inBonus: false,
  bonusBought: false,
  bonusTiers: [],
  wasCapped: false,

  stage: 0,             // 0 = рулетка в центрі, поле внизу; 1 = гра
  stageTarget: 0,
  camY: 0,
  hoverCol: -1,
  shake: 0,
  particles: [],
  popups: [],
  flash: 0,
  flashColor: '#fff',
  resultT: 0,
  timer: 0,
  timerFn: null,

  init() {
    this.canvas = document.getElementById('game');
    this.ctx = this.canvas.getContext('2d');
    this.reel = new Reel();
    this.layout();
    window.addEventListener('resize', () => this.layout());

    this.resetMine(false);
    this.bindUI();
    this.state = 'IDLE';
    this.msg('Постав ставку і крути');

    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.04, (now - last) / 1000);
      last = now;
      this.update(dt);
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },

  /* ---------------- РОЗКЛАДКА ---------------- */
  layout() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = window.innerWidth;
    this.h = window.innerHeight - document.querySelector('.hud').offsetHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cell = Math.max(CONFIG.minCell, Math.min(CONFIG.maxCell, this.w / CONFIG.cols));
    this.fieldW = this.cell * CONFIG.cols;
    this.fieldX = (this.w - this.fieldW) / 2;

    // комірка рулетки: втричі ширша за висоту, але щоб влізла в екран
    const R = CONFIG.reel;
    let ih = Math.max(58, Math.min(104, this.h / (R.visible + 2.8)));
    let iw = ih * R.widthRatio;
    const maxW = this.w - 80;
    if (iw > maxW) { iw = maxW; ih = iw / R.widthRatio; }
    this.itemH = ih;
    this.itemW = iw;

    // найвища точка камери: поки крутиться рулетка, поверхня стоїть низько
    this.camMin = -(this.h * CONFIG.camIdle) / this.cell;
    if (this.camY < this.camMin) this.camY = this.camMin;
  },

  sx(x) { return this.fieldX + x * this.cell; },          // клітинки -> пікселі
  sy(y) { return (y - this.camY) * this.cell; },

  /* ---------------- UI ---------------- */
  bindUI() {
    const betBox = document.getElementById('bets');
    CONFIG.bets.forEach(b => {
      const el = document.createElement('button');
      el.className = 'bet' + (b === this.bet ? ' on' : '');
      el.textContent = b;
      el.onclick = () => {
        if (this.state !== 'IDLE') return;
        this.bet = b;
        Array.prototype.forEach.call(betBox.children, c => c.classList.toggle('on', +c.textContent === b));
        this.syncUI();
      };
      betBox.appendChild(el);
    });

    this.spinBtn = document.getElementById('spin');
    this.spinBtn.onclick = () => (this.state === 'RESULT' ? this.endBet() : this.startBet());

    this.buyBtn = document.getElementById('buy');
    this.buyBtn.onclick = () => this.buyBonus();

    this.canvas.addEventListener('mousemove', e => { this.hoverCol = this.colAt(this.mouse(e).x); });
    this.canvas.addEventListener('mouseleave', () => { this.hoverCol = -1; });
    this.canvas.addEventListener('click', e => {
      if (this.state === 'AIM') { const c = this.colAt(this.mouse(e).x); if (c >= 0) this.launch(c); }
      else if (this.state === 'RESULT' && this.resultT > 0.4) this.endBet();
    });
    document.addEventListener('keydown', e => {
      if (e.code !== 'Space') return;
      e.preventDefault();
      if (this.state === 'IDLE') this.startBet();
      else if (this.state === 'RESULT' && this.resultT > 0.4) this.endBet();
    });
    this.syncUI();
  },

  mouse(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  },

  colAt(px) {
    const c = Math.floor((px - this.fieldX) / this.cell);
    return (c >= 0 && c < CONFIG.cols) ? c : -1;
  },

  msg(t) { document.getElementById('msg').textContent = t; },

  syncUI() {
    document.getElementById('balance').textContent = Math.round(this.balance);
    const idle = this.state === 'IDLE';
    const can = idle && this.balance >= this.bet;
    this.spinBtn.disabled = !(can || this.state === 'RESULT');
    this.spinBtn.textContent = this.state === 'RESULT'
      ? (this.bonusPending ? 'БОНУСКА!' : 'ДАЛІ')
      : 'КРУТИТИ  -' + this.bet;

    const cost = this.bet * CONFIG.bonus.buyCost;
    this.buyBtn.textContent = 'БОНУС  -' + cost;
    this.buyBtn.disabled = !(idle && this.balance >= cost);

    document.querySelectorAll('.bet').forEach(b => { b.disabled = !idle; });
    const need = CONFIG.bonus.streak;
    document.getElementById('streak').textContent = need <= 6
      ? '●'.repeat(this.streak) + '○'.repeat(Math.max(0, need - this.streak))
      : this.streak + '/' + need;
  },

  wait(sec, fn) { this.timer = sec; this.timerFn = fn; },

  /* ---------------- ЗВИЧАЙНА СТАВКА ---------------- */
  startBet() {
    if (this.state !== 'IDLE' || this.balance < this.bet) return;
    this.balance -= this.bet;
    this.inBonus = false;
    this.reel.bonusMode = false;
    this.bonusBought = false;
    this.spinIndex = 0;
    this.results = [];
    this.betWin = 0;
    this.wasCapped = false;
    this.stageTarget = 0;
    this.syncUI();
    this.nextSpin();
  },

  nextSpin() {
    if (this.spinIndex >= CONFIG.spinsPerBet) return this.finishBet();
    this.state = 'SPIN';
    this.msg('Спроба ' + (this.spinIndex + 1) + ' / ' + CONFIG.spinsPerBet);
    this.reel.start(this.reel.roll(), (item) => this.onLanded(item));
  },

  onLanded(item) {
    this.results[this.spinIndex] = item;

    if (item.none) {                                  // пусто — наступна спроба
      this.msg('Пусто');
      this.wait(CONFIG.reel.gapMs / 1000, () => { this.spinIndex++; this.nextSpin(); });
      return;
    }

    // випала кірка — прокрути зупиняються, рулетка їде вгору
    this.tier = item;
    this.resetMine(false);
    this.state = 'RISE';
    this.stageTarget = 1;
    this.msg(item.name + '! Пішли копати');
    this.wait(CONFIG.reel.riseMs / 1000, () => {
      if (CONFIG.manualAim) {
        this.state = 'AIM';
        this.msg(this.tier.name + ' — обери колонку');
      } else {
        this.launch(Math.floor(Math.random() * CONFIG.cols));
      }
    });
  },

  launch(col) {
    this.run = new Run([this.tier], this.mine, { cols: [col] });
    this.state = 'RUNNING';
    this.msg('');
  },

  onRunOver() {
    const win = this.run.payout(this.bet);
    this.wasCapped = this.run.isCapped(this.bet);
    this.betWin += win;
    this.balance += win;
    this.state = 'DROPDONE';
    this.msg('Глибина ' + Math.floor(this.run.depth) + ', блоків ' + this.run.blocks + '  →  +' + win);
    this.syncUI();
    this.wait(1.1, () => (this.inBonus ? this.finishBonus() : this.finishBet()));
  },

  finishBet() {
    const pick = this.results.find(r => r && !r.none);

    // стрік: кірка випала N ставок підряд -> бонуска. Поточну ставку не перериває.
    if (pick) this.streak++; else this.streak = 0;
    if (this.streak >= CONFIG.bonus.streak) { this.streak = 0; this.bonusPending = true; }

    this.history.unshift({ item: pick || NOTHING, win: this.betWin, bet: this.bet,
                           x: this.betWin / this.bet, bonus: false });
    if (this.history.length > 12) this.history.pop();

    this.state = 'RESULT';
    this.resultT = 0;
    const net = this.betWin - this.bet;
    this.msg(this.bonusPending ? 'ТРИ КІРКИ ПІДРЯД — БОНУСКА!'
                               : (net >= 0 ? 'ВИГРАШ +' + net : 'ПРОГРАШ ' + net));
    this.syncUI();
  },

  endBet() {
    if (this.state !== 'RESULT') return;
    if (this.bonusPending) { this.bonusPending = false; return this.startBonus(false); }
    this.resetMine(false);
    this.tier = null;
    this.run = null;
    this.results = [];
    this.inBonus = false;
    this.stageTarget = 0;
    this.state = 'IDLE';
    this.msg(this.balance < this.bet ? 'Мало монет — зменш ставку' : 'Постав ставку і крути');
    this.syncUI();
  },

  /* ---------------- БОНУСНА ГРА ---------------- */
  buyBonus() {
    const cost = this.bet * CONFIG.bonus.buyCost;
    if (this.state !== 'IDLE' || this.balance < cost) return;
    this.balance -= cost;
    this.bonusBought = true;
    this.startBonus(true);
  },

  startBonus(bought) {
    this.inBonus = true;
    this.reel.bonusMode = true;
    this.bonusBought = !!bought;
    this.bonusTiers = [];
    this.results = [];
    this.spinIndex = 0;
    this.betWin = 0;
    this.wasCapped = false;
    this.stageTarget = 0;
    this.run = null;
    this.resetMine(true);
    this.syncUI();
    this.bonusSpin();
  },

  bonusSpin() {
    const B = CONFIG.bonus;
    if (this.spinIndex >= B.spins) return this.bonusLaunch();

    this.state = 'BSPIN';
    this.msg('БОНУС  ' + (this.spinIndex + 1) + ' / ' + B.spins +
             '   кірок: ' + this.bonusTiers.length);

    let item = this.reel.roll(true);
    // гарантія: на останньому прокруті форсимо кірку, якщо досі нічого
    const left = B.spins - this.spinIndex;
    if (item.none && this.bonusTiers.length < B.guarantee && left <= B.guarantee - this.bonusTiers.length)
      item = World.pickItem(TIERS);

    this.reel.start(item, (res) => {
      this.results[this.spinIndex] = res;
      if (!res.none) {
        this.bonusTiers.push(res);
        this.flash = 0.25; this.flashColor = '#ffd34d';
      }
      this.wait(B.gapMs / 1000, () => { this.spinIndex++; this.bonusSpin(); });
    }, B.spinMs);
  },

  bonusLaunch() {
    this.state = 'RISE';
    this.stageTarget = 1;
    this.msg('Кірок у шахту: ' + this.bonusTiers.length);
    this.wait(CONFIG.reel.riseMs / 1000, () => {
      this.run = new Run(this.bonusTiers, this.mine);
      this.state = 'RUNNING';
      this.msg('');
    });
  },

  finishBonus() {
    this.history.unshift({ item: this.bonusTiers[0] || NOTHING, win: this.betWin, bet: this.bet,
                           x: this.betWin / this.bet, bonus: true });
    if (this.history.length > 12) this.history.pop();

    this.state = 'RESULT';
    this.resultT = 0;
    this.msg('БОНУСКА: +' + this.betWin);
    this.syncUI();
  },

  /* ---------------- ШАХТА ---------------- */
  resetMine(bonus) {
    this.mine = new World.Mine(CONFIG.cols, null, bonus);
    this.run = null;
    this.particles = [];
    this.popups = [];
    this.camY = this.camMin;
  },

  /* ---------------- ПОДІЇ ФІЗИКИ ---------------- */
  drainEvents() {
    const r = this.run;
    for (const e of r.events) {
      if (e.t === 'crack') {
        this.burst(e.c + 0.5, e.r + 0.5, BLOCKS[e.id].color, 4, 0.7);
        this.shake = Math.min(10, this.shake + 1.6);
      } else if (e.t === 'break') {
        this.burst(e.c + 0.5, e.r + 0.5, BLOCKS[e.id].color, 12);
        if (e.got > 0) this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.0,
                                          text: '+' + e.got, color: BLOCKS[e.id].color, size: 0.2 });
        this.shake = Math.min(14, this.shake + 3);
      } else if (e.t === 'mult') {
        this.burst(e.c + 0.5, e.r + 0.5, '#ffd34d', 44, 2.4);
        this.shake = 22;
        this.flash = 0.45; this.flashColor = '#ffd34d';
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.8,
                           text: 'X' + e.m, color: '#ffe98a', size: 0.42 });
      } else if (e.t === 'tnt') {
        this.burst(e.c + 0.5, e.r + 0.5, '#ff8a2b', 46, 3);
        for (const h of e.hit) this.burst(h.c + 0.5, h.r + 0.5, BLOCKS[h.id].color, 8);
        this.shake = 26;
        this.flash = 0.35; this.flashColor = '#ff7a2b';
        this.popups.push({ x: e.c + 0.5, y: e.r + 0.5, life: 1.3,
                           text: 'БУМ!', color: '#ff8a2b', size: 0.26 });
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
  },

  burst(x, y, color, n, power) {
    if (this.particles.length > 900) return;
    const k = power || 1;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.6 + Math.random() * 3.2) * k;
      this.particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.5,
        size: 0.05 + Math.random() * 0.09,
        life: 0.4 + Math.random() * 0.6, color
      });
    }
  },

  /* ---------------- UPDATE ---------------- */
  update(dt) {
    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer <= 0) { const f = this.timerFn; this.timerFn = null; this.timer = 0; if (f) f(); }
    }

    this.reel.update(dt);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 55);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 1.6);
    if (this.state === 'RESULT') this.resultT += dt;

    // перехід «рулетка в центрі» <-> «гра»
    const sp = dt / (CONFIG.reel.riseMs / 1000);
    if (this.stage < this.stageTarget) this.stage = Math.min(this.stageTarget, this.stage + sp);
    else if (this.stage > this.stageTarget) this.stage = Math.max(this.stageTarget, this.stage - sp);

    if (this.state === 'RUNNING' && this.run) {
      this.run.step(dt);
      this.drainEvents();
      if (this.run.over) this.onRunOver();
    }

    // камера тримає найглибшу живу кірку
    let target = this.camMin;
    if (this.run) {
      const alive = this.run.alive;
      const lead = alive.length ? Math.max.apply(null, alive.map(p => p.y)) : this.run.depth;
      target = lead - (this.h * CONFIG.camLead) / this.cell;
    }
    if (target > this.camY || !this.run) {
      this.camY += (target - this.camY) * Math.min(1, dt * CONFIG.camLerp);
    }
    if (this.camY < this.camMin) this.camY = this.camMin;
    if (this.mine) this.mine.prune(Math.floor(this.camY) - 6);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vy += 22 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i];
      p.y -= 0.9 * dt; p.life -= dt;
      if (p.life <= 0) this.popups.splice(i, 1);
    }
  },

  /* ---------------- DRAW ---------------- */
  draw() {
    const ctx = this.ctx;
    Render.pixelate(ctx);
    this.drawSky(ctx);

    ctx.save();
    if (this.shake > 0) ctx.translate((Math.random() - .5) * this.shake, (Math.random() - .5) * this.shake);
    this.drawMine(ctx);
    this.drawAim(ctx);
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
      if (this.inBonus) {
        Render.text(ctx, 'БОНУСНА ГРА', this.w / 2, cy - this.itemH * CONFIG.reel.visible / 2 - 72,
                    '800 26px ui-monospace, monospace', '#ffd34d');
      }
    }

    this.drawTrack(ctx);
    this.drawHistory(ctx);
    this.drawOverlay(ctx);
    if (this.state === 'RESULT') this.drawResult(ctx);
  },

  drawSky(ctx) {
    const horizon = this.sy(0);
    const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
    g.addColorStop(0, this.inBonus ? '#5b3a8f' : '#4aa8f0');
    g.addColorStop(1, this.inBonus ? '#a97fe0' : '#9fd6ff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, Math.max(0, horizon));
    ctx.fillStyle = this.inBonus ? '#120a1c' : '#0a0c10';
    ctx.fillRect(0, Math.max(0, horizon), this.w, this.h - Math.max(0, horizon));
  },

  drawMine(ctx) {
    const cell = this.cell;
    const r0 = Math.max(0, Math.floor(this.camY) - 1);
    const r1 = Math.ceil(this.camY + this.h / cell) + 1;
    for (let r = r0; r <= r1; r++) {
      const y = this.sy(r);
      for (let c = 0; c < CONFIG.cols; c++) {
        const b = this.mine.get(r, c);
        if (!b || b === World.WALL) continue;
        const x = this.sx(c);
        Render.block(ctx, x, y, cell, b);
        Render.shade(ctx, x, y, cell, r);
      }
    }
  },

  drawAim(ctx) {
    if (this.state !== 'AIM' || this.hoverCol < 0 || !this.tier) return;
    const x = this.sx(this.hoverCol);
    ctx.fillStyle = 'rgba(255,211,77,.16)';
    ctx.fillRect(x, 0, this.cell, this.h);
    ctx.strokeStyle = 'rgba(255,211,77,.7)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    ctx.strokeRect(x + 1.5, 0, this.cell - 3, this.h);
    ctx.setLineDash([]);
    Render.pickaxe(ctx, x + this.cell / 2, this.sy(-CONFIG.phys.startHeight),
                   this.cell * 1.4, this.tier, -0.4, false);
  },

  drawParticles(ctx) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2.2));
      ctx.fillStyle = p.color;
      const s = p.size * this.cell;
      ctx.fillRect(this.sx(p.x), this.sy(p.y), s, s);
    }
    ctx.globalAlpha = 1;
  },

  drawPicks(ctx) {
    if (!this.run) return;
    for (const p of this.run.picks) {
      const x = this.sx(p.x), y = this.sy(p.y);
      if (p.dead) ctx.globalAlpha = 0.25;
      Render.pickaxe(ctx, x, y, this.cell * 1.5, p.tier, p.rot, p.enchanted);
      ctx.globalAlpha = 1;
      if (!p.dead && this.state === 'RUNNING')
        Render.hpLabel(ctx, x, y - this.cell * 0.92, p.hp, p.hpMax, this.cell);
    }
  },

  drawPopups(ctx) {
    for (const p of this.popups) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.4));
      Render.text(ctx, p.text, this.sx(p.x), this.sy(p.y),
                  '800 ' + Math.round(this.cell * (p.size || 0.2)) + 'px ui-monospace, monospace', p.color);
    }
    ctx.globalAlpha = 1;
  },

  /* Стіни шахти по боках, якщо поле вужче за екран */
  drawWalls(ctx) {
    if (this.fieldX <= 0) return;
    ctx.fillStyle = this.inBonus ? '#0d0716' : '#05070a';
    ctx.fillRect(0, 0, this.fieldX, this.h);
    ctx.fillRect(this.fieldX + this.fieldW, 0, this.fieldX + 2, this.h);
  },

  /* Доріжка спроб */
  drawTrack(ctx) {
    if (this.state === 'IDLE') return;
    const n = this.inBonus ? CONFIG.bonus.spins : CONFIG.spinsPerBet;
    const s = Math.min(40, (this.w - 40) / n - 7);
    const gap = Math.min(7, s * 0.18);
    const totalW = n * s + (n - 1) * gap;
    const x0 = (this.w - totalW) / 2;
    const y = 14;

    Render.panel(ctx, x0 - 10, y - 8, totalW + 20, s + 16, this.inBonus ? '#4a3560' : '#2c323b', 4);

    for (let i = 0; i < n; i++) {
      const x = x0 + i * (s + gap);
      const res = this.results[i];
      const cur = i === this.spinIndex && (this.state === 'SPIN' || this.state === 'BSPIN');

      Render.inset(ctx, x, y, s, s, cur ? '#4a4433' : '#1b1f26', 3);
      if (res) {
        if (res.none) Render.cross(ctx, x + s / 2, y + s / 2, s * 0.42, 0.9);
        else Render.pickaxe(ctx, x + s / 2, y + s / 2, s * 0.84, res, -0.5, false);
      }
      if (cur) {
        ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 3;
        ctx.strokeRect(x + 1.5, y + 1.5, s - 3, s - 3);
      }
    }
  },

  /* Історія ставок — колонка зліва */
  drawHistory(ctx) {
    if (this.w < 720 || !this.history.length) return;
    const w = 156, rh = 34, x = 14, y = 86;
    const n = Math.min(this.history.length, Math.max(2, Math.floor((this.h - y - 30) / rh) - 1));

    Render.panel(ctx, x, y, w, 26 + n * rh, '#2c323b', 4);
    Render.text(ctx, 'ОСТАННІ', x + w / 2, y + 18, '700 12px ui-monospace, monospace', '#b9c2ce');

    for (let i = 0; i < n; i++) {
      const e = this.history[i];
      const ry = y + 26 + i * rh;
      const won = e.win >= e.bet;
      Render.inset(ctx, x + 6, ry + 2, w - 12, rh - 5,
                   e.bonus ? '#3a2b52' : (i === 0 ? '#1f2a22' : '#1b1f26'), 3);

      if (e.item.none) Render.cross(ctx, x + 24, ry + rh / 2, 13, 0.85);
      else Render.pickaxe(ctx, x + 24, ry + rh / 2, 27, e.item, -0.5, false);
      if (e.bonus) Render.text(ctx, 'B', x + 40, ry + rh / 2 + 5,
                               '800 11px ui-monospace, monospace', '#d9a3ff', 'left');

      Render.text(ctx, 'x' + e.x.toFixed(2), x + w - 12, ry + rh / 2 + 5,
                  '700 14px ui-monospace, monospace',
                  e.win === 0 ? '#7a8595' : (won ? '#5ce08a' : '#e0925c'), 'right');
    }
  },

  drawOverlay(ctx) {
    const showRun = this.run && (this.state === 'RUNNING' || this.state === 'DROPDONE');
    if (!showRun) return;

    const r = this.run;
    const pw = 246, px = this.w - pw - 14, y = 86;
    const alive = r.alive.length;
    Render.panel(ctx, px, y, pw, 104, this.inBonus ? '#4a3560' : '#2c323b', 4);

    if (this.inBonus) {
      Render.text(ctx, 'БОНУС  ' + alive + '/' + r.picks.length, px + 12, y + 24,
                  '800 17px ui-monospace, monospace', '#ffd34d', 'left');
      Render.text(ctx, 'X' + r.multChain, px + pw - 12, y + 24,
                  '800 17px ui-monospace, monospace', '#ffe98a', 'right');
    } else {
      const p = r.picks[0];
      Render.text(ctx, p.tier.name + (p.enchanted ? ' *' : ''), px + 12, y + 24,
                  '800 17px system-ui, sans-serif', p.enchanted ? '#d9a3ff' : '#fff', 'left');
      Render.text(ctx, 'УРОН ' + p.tier.dmg, px + pw - 12, y + 24,
                  '700 13px ui-monospace, monospace', '#ffd34d', 'right');
    }

    Render.text(ctx, 'глибина ' + Math.floor(r.depth), px + 12, y + 48,
                '700 14px ui-monospace, monospace', '#b9c2ce', 'left');
    Render.text(ctx, 'блоків ' + r.blocks, px + 12, y + 68,
                '700 14px ui-monospace, monospace', '#b9c2ce', 'left');

    const win = r.payout(this.bet);
    Render.text(ctx, '+' + win, px + pw - 12, y + 94,
                '800 28px ui-monospace, monospace', win >= this.bet ? '#5ce08a' : '#ffd34d', 'right');
  },

  drawResult(ctx) {
    const a = Math.min(1, this.resultT * 3);
    const bw = Math.min(420, this.w - 40), bh = 176;
    const bx = (this.w - bw) / 2, by = this.h / 2 - bh / 2;
    ctx.globalAlpha = a;

    const bonusRun = this.inBonus;
    Render.panel(ctx, bx, by, bw, bh, bonusRun ? '#4a3560' : '#2c323b', 5);
    const mid = bx + bw / 2;
    const spent = bonusRun && this.bonusBought ? this.bet * CONFIG.bonus.buyCost : this.bet;
    const net = this.betWin - spent;

    Render.text(ctx, bonusRun
        ? ('БОНУСКА  ·  КІРОК ' + this.bonusTiers.length + (this.bonusBought ? '  ·  КУПЛЕНА' : '  ·  ЗА СТРІК'))
        : ('СТАВКА ' + this.bet + '  ·  СПРОБ ' + this.results.length + '/' + CONFIG.spinsPerBet),
      mid, by + 30, '700 13px ui-monospace, monospace', '#c8b4e0');

    Render.text(ctx, '+' + Math.round(this.betWin), mid, by + 84,
                '800 46px ui-monospace, monospace', net >= 0 ? '#5ce08a' : '#e05c5c');

    const pick = this.results.find(r => r && !r.none);
    if (this.wasCapped) {
      Render.text(ctx, 'СТЕЛЯ ВИГРАШУ x' + CONFIG.maxWinX, mid, by + 116,
                  '800 15px ui-monospace, monospace', '#ffd34d');
    } else {
      Render.text(ctx, bonusRun
          ? ('множник X' + (this.run ? this.run.multChain : 1) + '  ·  x' + (this.betWin / spent).toFixed(2))
          : (pick ? (pick.name + '  ·  x' + (this.betWin / this.bet).toFixed(2))
                  : 'кірка не випала — ставка згоріла'),
        mid, by + 116, '700 13px ui-monospace, monospace', '#9aa4b2');
    }

    Render.text(ctx, this.bonusPending ? 'далі — БОНУСНА ГРА' : 'клік або пробіл — далі',
                mid, by + 152, '700 12px ui-monospace, monospace',
                this.bonusPending ? '#ffd34d' : '#7a8595');
    ctx.globalAlpha = 1;
  }
};
