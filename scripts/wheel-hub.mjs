/* ============================================================
   НОРМАЛІЗАТОР ВТУЛКИ (центр колеса).

   Втулка крутиться РАЗОМ із колесом, тому вимога до неї жорсткіша, ніж
   до обідника: якщо намальоване коло сидить у полотні хоч трохи повз
   центр, на прокруті це видно як биття. Око ловить такий зсув куди
   раніше, ніж будь-яку іншу неточність.

   Що робить:
     1. лишає найбільшу зв'язну пляму — генератор сипле по краях цятки
        (у присланому файлі були зелена ліворуч і червона внизу), і саме
        вони збивали заміри;
     2. міряє справжній центр і радіус цієї плями — не по рамці, а по
        медіані країв, щоб випадкові виступи не тягли центр на себе;
     3. перемальовує втулку в квадрат, де коло стоїть рівно посередині
        й торкається країв.

   Запуск:  node scripts/wheel-hub.mjs
   ============================================================ */

import sharp from 'sharp';

const SRC = 'art/wheel/центр.png';
const OUT = 'apps/web/public/wheel/центр.png';
const SIZE = 512;

const { data, info } = await sharp(SRC).ensureAlpha().raw()
  .toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const solid = (i) => data[i * 4 + 3] > 20;

/* 1. найбільша пляма */
const lab = new Int32Array(W * H).fill(-1);
let best = -1, bestN = 0;
for (let s = 0; s < W * H; s++) {
  if (lab[s] !== -1 || !solid(s)) continue;
  let n = 0;
  const q = [s];
  lab[s] = s;
  while (q.length) {
    const p = q.pop();
    const x = p % W, y = (p - x) / W;
    n++;
    for (const [a, b] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (a < 0 || b < 0 || a >= W || b >= H) continue;
      const t = b * W + a;
      if (lab[t] === -1 && solid(t)) { lab[t] = s; q.push(t); }
    }
  }
  if (n > bestN) { bestN = n; best = s; }
}

/* 2. центр і радіус.

   Центр беремо як середину медіанних країв по рядках і стовпцях, а не
   як центр габаритного прямокутника: прямокутник зміщує будь-який
   одиночний виступ, а медіана його просто не помічає. */
const mid = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
const rowL = [], rowR = [], colT = [], colB = [];
for (let y = 0; y < H; y++) {
  let l = -1, r = -1;
  for (let x = 0; x < W; x++) if (lab[y * W + x] === best) { if (l < 0) l = x; r = x; }
  if (l >= 0 && r - l > W * 0.5) { rowL.push(l); rowR.push(r); }
}
for (let x = 0; x < W; x++) {
  let t = -1, b = -1;
  for (let y = 0; y < H; y++) if (lab[y * W + x] === best) { if (t < 0) t = y; b = y; }
  if (t >= 0 && b - t > H * 0.5) { colT.push(t); colB.push(b); }
}
const cx = (mid(rowL) + mid(rowR)) / 2;
const cy = (mid(colT) + mid(colB)) / 2;

/* Радіус — максимальний по плямі: втулка кругла, тож це її край.
   Беремо саме максимум, а не середнє: недобрати радіус означає зрізати
   золоту обручку по краю. */
let R = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (lab[y * W + x] !== best) continue;
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d > R) R = d;
  }
}

/* 3. перемальовуємо в квадрат із колом рівно посередині */
const rgba = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  rgba[i * 4] = data[i * 4];
  rgba[i * 4 + 1] = data[i * 4 + 1];
  rgba[i * 4 + 2] = data[i * 4 + 2];
  rgba[i * 4 + 3] = lab[i] === best ? data[i * 4 + 3] : 0;
}

const k = SIZE / (R * 2);
const w2 = Math.round(W * k), h2 = Math.round(H * k);
const left = Math.round(SIZE / 2 - cx * k);
const top = Math.round(SIZE / 2 - cy * k);

const scaled = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
  .resize(w2, h2, { kernel: 'nearest' }).png().toBuffer();

/* sharp не кладе більше в менше — спершу вирізаємо те, що потрапляє в
   кадр, і накладаємо вже його. */
const sx = Math.max(0, -left), sy = Math.max(0, -top);
const dx = Math.max(0, left), dy = Math.max(0, top);
const piece = await sharp(scaled)
  .extract({
    left: sx, top: sy,
    width: Math.min(SIZE - dx, w2 - sx),
    height: Math.min(SIZE - dy, h2 - sy),
  }).png().toBuffer();

await sharp({
  create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
}).composite([{ input: piece, left: dx, top: dy }]).png().toFile(OUT);

console.log(`центр ${cx.toFixed(1)},${cy.toFixed(1)} (полотно ${W / 2},${H / 2})  `
  + `радіус ${R.toFixed(1)}  пікселів ${bestN}`);
