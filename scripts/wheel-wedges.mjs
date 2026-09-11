/* ============================================================
   НОРМАЛІЗАТОР СЕКТОРІВ КОЛЕСА.

   Приймає намальовані сектори (як їх віддав генератор) і робить із них
   файли, придатні для складання колеса: прозорий фон, однакова
   геометрія, точний кут.

   НАВІЩО ЦЕ ПОТРІБНО. Генератор повертає jpeg, у якому «прозорість»
   намальована шахматкою, а сам сектор щоразу іншого розміру, під іншим
   кутом і з вершиною не там, де просили. Складати з такого колесо
   неможливо: сектори або перекриються, або лишать щілини.

   ЩО РОБИТЬ:
     1. бере маску сектора: з альфи, якщо вона є, інакше знімає
        шахматку заливкою від країв (вона СІРА, а арт кольоровий);
     2. лишає найбільшу зв'язну пляму — дрібні цятки по краях геть;
     3. міряє вершину й радіус цієї плями;
     4. перемальовує сектор так, щоб вершина стала в (256, 512), а
        радіус дорівнював 512, і обрізає рівно по куту 360/N.

   Крок 4 потрібен навіть для чистих png з альфою: у присланих файлах
   кут коливався від 65° до 82°, а радіус від 310 до 348. Без
   вирівнювання сектори або перекриються, або лишать щілини.

   На виході — 512x512 PNG з альфою, у яких сектор займає точний клин.
   Далі клієнту лишається тільки повернути кожен на i * (360/N).

   Запуск:  node scripts/wheel-wedges.mjs <кількість секторів>
   ============================================================ */

import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

/* Вихідники лежать поза public: вони важать по 200 КБ і роздавати
   їх нема сенсу — у гру йдуть уже нормалізовані png. */
const SRC = 'art/wheel';
const OUT = 'apps/web/public/wheel';
/* Ім'я файлу = id призу з сервера. Новий приз — новий файл, і більше
   нічого міняти не треба. */
const NAMES = ['cash10', 'cash25', 'cash50', 'cash100', 'spins5'];
const SIZE = 512;
const SECTORS = Number(process.argv[2] || 6);

/* Шахматка — сіра й темна. Арт сектора кольоровий (темно-синій
   #1e2630 або золото), тому різниця каналів його рятує. */
const isGrey = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) <= 10
  && Math.max(r, g, b) <= 150;

function wedgeMask(data, W, H, ch) {
  /* Є альфа — беремо маску з неї: це найточніше джерело, і возитися з
     кольорами не треба. */
  if (ch === 4) {
    const lab = new Int32Array(W * H).fill(-1);
    let best = -1, bestN = 0;
    for (let sy = 0; sy < H; sy++) {
      for (let sx = 0; sx < W; sx++) {
        const s = sy * W + sx;
        if (lab[s] !== -1 || data[s * 4 + 3] <= 40) continue;
        const id = s;
        let n = 0;
        const q = [s];
        lab[s] = id;
        while (q.length) {
          const p = q.pop();
          const x = p % W, y = (p - x) / W;
          n++;
          for (const [a, b] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
            if (a < 0 || b < 0 || a >= W || b >= H) continue;
            const t = b * W + a;
            if (lab[t] === -1 && data[t * 4 + 3] > 40) { lab[t] = id; q.push(t); }
          }
        }
        if (n > bestN) { bestN = n; best = id; }
      }
    }
    return { lab, best, bestN };
  }

  /* 1. фон — заливка від країв по сірому */
  const bg = new Uint8Array(W * H);
  const st = [];
  for (let x = 0; x < W; x++) st.push(x, 0, x, H - 1);
  for (let y = 0; y < H; y++) st.push(0, y, W - 1, y);
  while (st.length) {
    const y = st.pop(), x = st.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (bg[i]) continue;
    const p = (y * W + x) * ch;
    if (!isGrey(data[p], data[p + 1], data[p + 2])) continue;
    bg[i] = 1;
    st.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }

  /* 2. найбільша пляма арту — це й є сектор; решта то jpeg-цятки */
  const lab = new Int32Array(W * H).fill(-1);
  let best = -1, bestN = 0;
  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const s = sy * W + sx;
      if (lab[s] !== -1 || bg[s]) continue;
      const id = s;
      let n = 0;
      const q = [s];
      lab[s] = id;
      while (q.length) {
        const p = q.pop();
        const x = p % W, y = (p - x) / W;
        n++;
        const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
        for (const [a, b] of nb) {
          if (a < 0 || b < 0 || a >= W || b >= H) continue;
          const t = b * W + a;
          if (lab[t] === -1 && !bg[t]) { lab[t] = id; q.push(t); }
        }
      }
      if (n > bestN) { bestN = n; best = id; }
    }
  }
  return { lab, best, bestN };
}

async function normalise(name) {
  const src = `${SRC}/${name}.png`;
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  const { lab, best, bestN } = wedgeMask(data, W, H, ch);

  /* вершина: найнижча точка плями, x — середина того рядка */
  let ax = 0, ay = -1, R = 0;
  for (let y = H - 1; y >= 0 && ay < 0; y--) {
    let sum = 0, cnt = 0;
    for (let x = 0; x < W; x++) if (lab[y * W + x] === best) { sum += x; cnt++; }
    if (cnt) { ay = y; ax = sum / cnt; }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (lab[y * W + x] !== best) continue;
      const d = Math.hypot(x - ax, ay - y);
      if (d > R) R = d;
    }
  }

  /* rgba з альфою по масці */
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const p = i * ch;
    rgba[i * 4] = data[p];
    rgba[i * 4 + 1] = data[p + 1];
    rgba[i * 4 + 2] = data[p + 2];
    rgba[i * 4 + 3] = lab[i] === best ? 255 : 0;
  }

  /* Масштаб так, щоб радіус сектора став рівно SIZE, і зсув, щоб
     вершина потрапила в (SIZE/2, SIZE). Домножуємо на 1.02: край
     сектора в арті трохи «з'їдений» контуром, і без запасу між
     секторами лишалась би волосінь. */
  const k = (SIZE / R) * 1.02;
  const w2 = Math.round(W * k), h2 = Math.round(H * k);
  const left = Math.round(SIZE / 2 - ax * k);
  const top = Math.round(SIZE - ay * k);

  const scaled = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .resize(w2, h2, { kernel: 'nearest' })
    .png()
    .toBuffer();

  /* Масштабована картинка більша за полотно, а sharp не вміє класти
     більше в менше — тому спершу вирізаємо з неї рівно ту частину, яка
     потрапляє в кадр, і кладемо вже її. */
  const sx = Math.max(0, -left), sy = Math.max(0, -top);
  const dx = Math.max(0, left), dy = Math.max(0, top);
  const cw = Math.min(SIZE - dx, w2 - sx), chh = Math.min(SIZE - dy, h2 - sy);
  const piece = await sharp(scaled)
    .extract({ left: sx, top: sy, width: cw, height: chh })
    .png()
    .toBuffer();

  const placed = await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: piece, left: dx, top: dy }]).png().toBuffer();

  /* Обрізання рівно по куту: клин із вершиною внизу, розкритий угору. */
  const half = (Math.PI / SECTORS);
  const x1 = SIZE / 2 - Math.sin(half) * SIZE * 1.5;
  const y1 = SIZE - Math.cos(half) * SIZE * 1.5;
  const x2 = SIZE / 2 + Math.sin(half) * SIZE * 1.5;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">`
    + `<path d="M${SIZE / 2} ${SIZE} L${x1.toFixed(1)} ${y1.toFixed(1)} `
    + `L${x2.toFixed(1)} ${y1.toFixed(1)} Z" fill="#fff"/></svg>`);

  await sharp(placed)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toFile(`${OUT}/${name}.png`);

  console.log(`${name}: вершина ${Math.round(ax)},${ay}  радіус ${Math.round(R)}  `
    + `пікселів ${bestN}`);
}

await mkdir(OUT, { recursive: true });
for (const name of NAMES) await normalise(name);
console.log(`готово: ${SECTORS} секторів по ${360 / SECTORS}°`);
