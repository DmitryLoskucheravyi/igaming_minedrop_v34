/* ============================================================
   REEL — вертикальна рулетка. Стрічка їде знизу вгору повз
   рамку по центру. Комірка втричі ширша за висоту.

   7 прокрутів = 7 ШАНСІВ. Перша ж кірка зупиняє прокрути
   і починається гра — решта не докручується.
   ============================================================ */
class Reel {
  constructor() {
    this.items = [];
    this.offset = 0;
    this.spinning = false;
    this.t = 0;
    this.result = null;
    this.onDone = null;
    this.idle();
  }

  roll(bonus) { return World.pickItem(bonus ? bonusReelTable() : reelTable()).item; }

  idle() {
    const R = CONFIG.reel;
    this.items = [];
    for (let i = 0; i < R.stripLen; i++) this.items.push(this.roll());
    this.offset = R.targetIndex;
  }

  /* ms — тривалість прокруту. У бонусці вона своя, коротша. */
  start(winner, onDone, ms) {
    const R = CONFIG.reel;
    this.result = winner;
    this.onDone = onDone;
    this.ms = ms || R.spinMs;

    this.items = [];
    for (let i = 0; i < R.stripLen; i++) this.items.push(this.roll(this.bonusMode));
    this.items[R.targetIndex] = winner;      // переможець стоїть на targetIndex

    this.from = 0;
    this.to = R.targetIndex;
    this.offset = 0;
    this.t = 0;
    this.spinning = true;
  }

  update(dt) {
    if (!this.spinning) return;
    this.t += dt;
    const p = Math.min(1, this.t / ((this.ms || CONFIG.reel.spinMs) / 1000));
    const e = 1 - Math.pow(1 - p, 5);                 // різкий старт, м'яка посадка
    this.offset = this.from + (this.to - this.from) * e;
    if (p >= 1) {
      this.spinning = false;
      const f = this.onDone; this.onDone = null;
      if (f) f(this.result);
    }
  }

  /* cx, cy — центр вікна рулетки */
  draw(ctx, cx, cy, itemW, itemH, alpha) {
    const R = CONFIG.reel;
    const winH = itemH * R.visible;
    const x = cx - itemW / 2;
    const y = cy - winH / 2;
    const pad = 18;

    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;

    // дерев'яна рама
    Render.wood(ctx, x - pad, y - pad - 34, itemW + pad * 2, winH + pad * 2 + 34);
    Render.text(ctx, 'ЩО ВИПАДЕ?', cx, y - pad - 10,
                '700 15px ui-monospace, monospace', '#f0d8a8');

    // темна ніша під стрічку
    Render.inset(ctx, x - 6, y - 6, itemW + 12, winH + 12, '#12151b', 5);

    // сама стрічка
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, itemW, winH);
    ctx.clip();

    const first = Math.max(0, Math.floor(this.offset) - Math.ceil(R.visible / 2) - 1);
    const last = Math.min(this.items.length - 1, first + R.visible + 3);
    for (let i = first; i <= last; i++) {
      const iy = cy - itemH / 2 + (i - this.offset) * itemH;
      const hot = !this.spinning && Math.abs(i - this.offset) < 0.5;
      Render.reelItem(ctx, x + 5, iy + 4, itemW - 10, itemH - 8, this.items[i], hot);
    }

    // затемнення зверху/знизу
    const gt = ctx.createLinearGradient(0, y, 0, y + itemH);
    gt.addColorStop(0, 'rgba(10,12,16,.96)'); gt.addColorStop(1, 'rgba(10,12,16,0)');
    ctx.fillStyle = gt; ctx.fillRect(x, y, itemW, itemH);
    const gb = ctx.createLinearGradient(0, y + winH, 0, y + winH - itemH);
    gb.addColorStop(0, 'rgba(10,12,16,.96)'); gb.addColorStop(1, 'rgba(10,12,16,0)');
    ctx.fillStyle = gb; ctx.fillRect(x, y + winH - itemH, itemW, itemH);
    ctx.restore();

    // золоті куточки на виграшній комірці
    const sy = cy - itemH / 2;
    const L = Math.min(26, itemH * 0.36), th = 5;
    ctx.fillStyle = '#ffd34d';
    const corners = [
      [x, sy, L, th], [x, sy, th, L],
      [x + itemW - L, sy, L, th], [x + itemW - th, sy, th, L],
      [x, sy + itemH - th, L, th], [x, sy + itemH - L, th, L],
      [x + itemW - L, sy + itemH - th, L, th], [x + itemW - th, sy + itemH - L, th, L]
    ];
    corners.forEach(r => ctx.fillRect(r[0], r[1], r[2], r[3]));

    // стрілки по боках
    ctx.fillStyle = '#ffd34d';
    ctx.strokeStyle = '#0d0f13';
    ctx.lineWidth = 3;
    const a = 15;
    [[x - 10, 1], [x + itemW + 10, -1]].forEach(([px, dir]) => {
      ctx.beginPath();
      ctx.moveTo(px, cy);
      ctx.lineTo(px - dir * a, cy - a);
      ctx.lineTo(px - dir * a, cy + a);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
    });

    ctx.restore();
  }
}
