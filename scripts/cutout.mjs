/* ============================================================
   ЗНЯТИ ЗАПЕЧЕНУ ШАХМАТКУ.

   Генератор віддає png БЕЗ альфи, а «прозорий фон» у ньому просто
   намальований світлою шахматкою. Покласти такий файл у гру не можна:
   на екрані навколо кнопки буде сірий прямокутник у клітинку.

   ЯКЩО АЛЬФА ВЖЕ Є — шахматку не шукаємо взагалі, лишається тільки
   обрізати по межах непрозорого й змасштабувати. Це не оптимізація, а
   необхідність: заливка по «світлому й сірому» з'їла б білі відблиски
   на золоті, які виходять на самий край малюнка.

   Що робить із запеченою шахматкою:
     1. заливкою від країв знаходить фон — світлий і сірий (різниця
        каналів мала, яскравість висока). Саме заливкою, а не за
        кольором по всьому полотну: усередині кнопки теж є світлі
        сірі пікселі (відблиски), і за кольором вони б теж стерлись;
     2. лишає найбільшу зв'язну пляму — дрібні цятки по краях геть;
     3. обрізає по її межах і кладе альфу.

   Край пом'якшуємо: між шахматкою й малюнком є смуга півтонів, і без
   неї по контуру лишається світла облямівка.

   Запуск:  node scripts/cutout.mjs <вхід> <вихід> [ширина]
   ============================================================ */

import sharp from 'sharp';

const [SRC, OUT, WIDTH] = process.argv.slice(2);
if (!SRC || !OUT) {
  console.error('треба: node scripts/cutout.mjs <вхід> <вихід> [ширина]');
  process.exit(1);
}

const meta = await sharp(SRC).metadata();
const { data, info } = await sharp(SRC).ensureAlpha().raw()
  .toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;

/* «Має альфа-канал» ще не означає «нею користуються»: буває цілком
   непрозорий RGBA, і саме таким приходить файл із запеченою шахматкою,
   якщо його десь перезбережуть. Тому питаємо не метадані, а пікселі. */
const hasRealAlpha = !!meta.hasAlpha && (() => {
  for (let i = 0; i < W * H; i++) if (data[i * 4 + 3] < 250) return true;
  return false;
})();

/* Фон шахматки: майже без кольору й світлий. Пороги з запасом —
   у файлі вона гуляє від 230 до 255 і має легкий відтінок. */
const isBg = (i) => {
  const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12 && Math.min(r, g, b) >= 215;
};

const bg = new Uint8Array(W * H);
if (hasRealAlpha) {
  /* Фон — просто прозоре. Далі все та сама дорога: найбільша пляма,
     обрізання, масштаб. */
  for (let i = 0; i < W * H; i++) if (data[i * 4 + 3] < 8) bg[i] = 1;
} else {
  const st = [];
  for (let x = 0; x < W; x++) st.push(x, 0, x, H - 1);
  for (let y = 0; y < H; y++) st.push(0, y, W - 1, y);
  while (st.length) {
    const y = st.pop(), x = st.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const i = y * W + x;
    if (bg[i] || !isBg(i)) continue;
    bg[i] = 1;
    st.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
}

/* Найбільша пляма того, що лишилось — це й є кнопка. */
const lab = new Int32Array(W * H).fill(-1);
let best = -1, bestN = 0;
for (let s = 0; s < W * H; s++) {
  if (lab[s] !== -1 || bg[s]) continue;
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
      if (lab[t] === -1 && !bg[t]) { lab[t] = s; q.push(t); }
    }
  }
  if (n > bestN) { bestN = n; best = s; }
}

/* Альфа + пом'якшений край.

   Напівтони на межі малюнка й шахматки залишились би світлою
   облямівкою. Тому піксель, у якого серед сусідів є фон, отримує альфу
   за тим, наскільки він темніший за шахматку: чистий фоновий колір ->
   0, впевнено «свій» -> 255. */
const rgba = Buffer.alloc(W * H * 4);
let x0 = W, y0 = H, x1 = -1, y1 = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    rgba[i * 4] = data[i * 4];
    rgba[i * 4 + 1] = data[i * 4 + 1];
    rgba[i * 4 + 2] = data[i * 4 + 2];
    if (lab[i] !== best) { rgba[i * 4 + 3] = 0; continue; }

    let edge = false;
    for (const [a, b] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (a < 0 || b < 0 || a >= W || b >= H) continue;
      if (bg[b * W + a]) { edge = true; break; }
    }
    /* Своя альфа — беремо її як є; напівпрозорий край намальований
       рівно там, де треба, і перераховувати його з яскравості означало б
       зіпсувати готове. */
    let alpha = hasRealAlpha ? data[i * 4 + 3] : 255;
    if (edge && !hasRealAlpha) {
      const lum = Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      alpha = Math.max(0, Math.min(255, Math.round((230 - lum) / 230 * 255 * 1.6)));
    }
    rgba[i * 4 + 3] = alpha;
    if (alpha > 8) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
}

let img = sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
  .extract({ left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });

/* Ширину задають явно: у грі кнопка малюється дрібною, і тягати в
   браузер півтора мегабайти заради 160 px немає сенсу. */
if (WIDTH) img = img.resize({ width: Number(WIDTH), kernel: 'lanczos3' });

await img.png({ compressionLevel: 9 }).toFile(OUT);
const out = await sharp(OUT).metadata();
console.log(`${SRC}  (${hasRealAlpha ? 'альфа своя' : 'знято шахматку'})`
  + `
  пляма ${bestN} пікс, обрізано до ${x1 - x0 + 1}x${y1 - y0 + 1}`
  + `\n  -> ${OUT} ${out.width}x${out.height}`);
