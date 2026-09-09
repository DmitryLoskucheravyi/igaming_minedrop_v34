/* ============================================================
   BACKDROP — суцільне небо з хмарами, що пливуть. Без гір, без
   сонця, без «подорожі углиб» — той варіант відхилили, лишили
   найпростіше: небо і хмари, скільки не крути камеру.

   ЕКРАННИЙ ШАР, А НЕ СВІТОВИЙ
   Фон живе в координатах ЕКРАНА, не світу: та сама смуга неба на
   тому самому місці, скільки не копай углиб. Хмари пливуть по часу
   (clock), а не по позиції кірки.

   Малюється ПЕРШИМ, до самої шахти: блоки й огорожа лягають зверху й
   ховають фон там, де порода ціла. Видно його тільки в порожнечі —
   над полем і в тунелі, який прокопала кірка.

   ЧІТКИЙ МАЛЮНОК, РОЗМИТИЙ РЕЗУЛЬТАТ
   Хмари — растрова піксельна форма (масив рядків, де символ визначає
   тон клітинки). Небо — НАВПАКИ, суцільний аналоговий градієнт без
   жодної смуги: пробували дизер (впорядкований Bayer-паттерн замість
   різкої межі) — на екрані він читався саме як смуги, а не як
   градієнт, тож для неба це не підійшло. Хмари й далі піксельні,
   небо — плавне. М'якість дає ОКРЕМИЙ прохід —
   ctx.filter = 'blur(...)' на весь уже намальований шар.

   ЧОМУ РОЗМИТТЯ НЕ НА ВЕСЬ ЕКРАН
   Gaussian blur — один із найдорожчих канвас-фільтрів, а вартість
   росте з площею. Малювати небо й хмари прямо на головному канвасі
   на повній роздільності й розмивати ЦЕ щокадру — реальний ризик
   для FPS на слабких телефонах у вебв'ю телеграма. Тому весь шар
   спершу малюється на маленькому офскрін-буфері (BUFFER_SCALE площі),
   розмивається ТАМ (дешевше пропорційно площі — вчетверо менший буфер
   і блюр вчетверо дешевший), і одним drawImage розтягується на весь
   кадр. Розтягування зі згладжуванням додає ще трохи м'якості майже
   безкоштовно.
   ============================================================ */

type Ctx = CanvasRenderingContext2D;

/* Наскільки розмито (у px повнорозмірного екрана). Канвас під капотом
   масштабований на dpr (Presenter.layout виставляє setTransform(dpr,
   ...)), тож той самий рядок фільтра на Retina дав би вдвічі слабший
   розмив за фактом — radius множимо на dpr. Далі, коли рахуємо в
   маленькому буфері, множимо ще й на BUFFER_SCALE. */
const BLUR_PX = 2.4;

/* Буфер — частка площі екрана. 1/3 по кожній осі = 1/9 пікселів, тобто
   Gaussian blur коштує приблизно в 9 разів дешевше за той самий
   видимий результат. Менше — вже помітно на власні очі як розмазаний
   растр хмар, а не як м'який фокус. */
const BUFFER_SCALE = 1 / 3;

/* ---------------- небо ---------------- */

/* Опорні кольори градієнта — ті самі, що й у смугастій версії, просто
   тепер це справжні зупинки canvas-градієнта: браузер сам рахує
   плавний перехід між ними, без жодного видимого кроку. */
const SKY_STOPS: readonly [number, string][] = [
  [0.0, '#3f7fdb'],
  [0.22, '#4f96e6'],
  [0.46, '#6bb0ef'],
  [0.7, '#8fc7f5'],
  [1.0, '#b8ddfa'],
];

/* Запас за межі канваса для fillRect нижче. ctx.filter (blur) семплює
   пікселі ЗА краєм намальованого; без запасу за краєм там прозорість,
   і розмиття дає темну/напівпрозору кайму по всьому периметру екрана.
   Малюємо трохи ширше — градієнт за своїми ж зупинками просто
   продовжується кольором крайньої, тому жодного видимого стрибка.

   Значення — у px повнорозмірного екрана; scale переводить його в px
   того полотна, у яке малюємо ЗАРАЗ (буфер меншого розміру теж має
   свій запас, пропорційно менший). */
const EDGE_MARGIN = 16;

function drawSky(ctx: Ctx, w: number, h: number, scale: number): void {
  const margin = EDGE_MARGIN * scale;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  for (const [f, color] of SKY_STOPS) g.addColorStop(f, color);
  ctx.fillStyle = g;
  ctx.fillRect(-margin, -margin, w + margin * 2, h + margin * 2);
}

/* ---------------- хмари ---------------- */

/* Растрова форма хмари: кожен символ — тон клітинки, не силует
   одним кольором. '.' прозоро, 'H' — найсвітліше (вершина, де сонце),
   '#' — основне тіло, 's' — тінь на споді. Три тони замість одного —
   і є та «деталь», яку просили: хмара читається як об'єм, а не пляма. */
const CLOUD_SPRITES: readonly (readonly string[])[] = [
  [
    '...HHHHHH......',
    '..HHHHHHHHHH...',
    '.HH##########H.',
    'H##############',
    'H##############',
    '.####ssss#####.',
  ],
  [
    '......HHHH.........',
    '....HHHHHHHH..HHH..',
    '...HH######H.HHHHH.',
    '..H#############HH.',
    '.H###############H.',
    'H#################H',
    '.#################.',
    '..ssssssssssssssss.',
  ],
  [
    '..HHHH......',
    '.HHHHHHH....',
    'H########...',
    'H#########H.',
    '.#########H.',
    '..ssssssss..',
  ],
  [
    '....HHH..HHHH.....',
    '..HHHHHHHHHHHH....',
    '.H###############.',
    'H#################',
    'H#################',
    '.###ssss####ssss#.',
    '..sssssssssssssss.',
  ],
];

const TONE: Record<string, string> = {
  H: '#ffffff',
  '#': '#eaf4fb',
  s: '#c3d9ec',
};

function paintSprite(ctx: Ctx, x: number, y: number, unit: number, sprite: readonly string[]): void {
  const u = Math.ceil(unit);
  for (let r = 0; r < sprite.length; r++) {
    const row = sprite[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === '.') continue;
      ctx.fillStyle = TONE[ch] ?? TONE['#'];
      ctx.fillRect(Math.round(x + c * unit), Math.round(y + r * unit), u, u);
    }
  }
}

function drawCloudSprite(ctx: Ctx, x: number, y: number, unit: number, sprite: readonly string[]): void {
  // тінь на землю/повітря під хмарою — той самий силует, зсунутий
  // вниз-праворуч, щоб хмара трохи «висіла» над фоном
  ctx.fillStyle = 'rgba(140,182,222,.45)';
  const u = Math.ceil(unit);
  for (let r = 0; r < sprite.length; r++) {
    const row = sprite[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === '.') continue;
      ctx.fillRect(
        Math.round(x + c * unit + unit * 0.22),
        Math.round(y + r * unit + unit * 0.22),
        u, u,
      );
    }
  }
  paintSprite(ctx, x, y, unit, sprite);
}

/* Кожна хмара — свій спрайт, розмір, висота й швидкість, тому небо не
   виглядає як один конвеєр. yFrac — частка висоти екрана (завжди у
   верхній половині — це небо). unit підняли проти першої версії
   (7–13 -> 9–16): за проханням «більш піксельне» клітинка має читатись
   як клітинка, а не розмазуватись у майже гладкий силует. */
interface CloudCfg {
  sprite: number;
  yFrac: number;
  unit: number;      // розмір однієї клітинки спрайту, px
  speed: number;     // px/сек екранного дрейфу
  phase: number;     // зсув старту, щоб хмари не рухались синхронно
}
const CLOUDS: readonly CloudCfg[] = [
  { sprite: 0, yFrac: 0.08, unit: 11, speed: 13, phase: 40 },
  { sprite: 1, yFrac: 0.20, unit: 15, speed: 8, phase: 260 },
  { sprite: 2, yFrac: 0.05, unit: 9, speed: 18, phase: 520 },
  { sprite: 3, yFrac: 0.30, unit: 13, speed: 10, phase: 90 },
  { sprite: 1, yFrac: 0.14, unit: 12, speed: 15, phase: 380 },
  { sprite: 2, yFrac: 0.26, unit: 10, speed: 17, phase: 610 },
];

/* Усі cfg.unit/speed/phase задані в px повнорозмірного екрана — так
   їх і підбирали на око. scale переводить їх у px поточного полотна
   (буфер менший -> хмара всередині нього менша рівно на ту саму
   частку -> після розтягування буфера назад вона знову правильного
   розміру). yFrac лишається часткою висоти, тому масштабувати його
   не треба — частка не залежить від роздільності. */
function drawClouds(ctx: Ctx, w: number, h: number, clock: number, scale: number): void {
  for (const cfg of CLOUDS) {
    const sprite = CLOUD_SPRITES[cfg.sprite];
    const unit = cfg.unit * scale;
    const cw = sprite[0].length * unit;
    const span = w + cw * 2;
    // нескінченний дрейф управо; вихід за правий край -> одразу заходить зліва
    const x = ((clock * cfg.speed * scale + cfg.phase * scale) % span) - cw;
    const y = cfg.yFrac * h;
    drawCloudSprite(ctx, x, y, unit, sprite);
  }
}

/* ---------------- офскрін-буфер ---------------- */

/* Один буфер на модуль, а не локальна змінна функції: створювати
   canvas щокадру само по собі не безкоштовне, а розмір екрана
   міняється рідко (resize, зміна масштабу рамки), тож тримаємо той
   самий canvas між кадрами й лише перевиставляємо width/height, коли
   вони реально зміняться. */
let bufCanvas: HTMLCanvasElement | null = null;
let bufCtx: Ctx | null = null;
let bufW = -1, bufH = -1;

function getBuffer(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } | null {
  if (!bufCanvas) {
    bufCanvas = document.createElement('canvas');
    bufCtx = bufCanvas.getContext('2d');
  }
  if (!bufCtx) return null;   // канвас недоступний (рідкість) — викликач сам упорається
  if (w !== bufW || h !== bufH) {
    bufW = w; bufH = h;
    bufCanvas.width = w;
    bufCanvas.height = h;
  }
  return { canvas: bufCanvas, ctx: bufCtx };
}

/* ---------------- вхідна точка ---------------- */

export function drawBackdrop(ctx: Ctx, w: number, h: number, clock: number, dpr: number): void {
  const bw = Math.max(1, Math.round(w * BUFFER_SCALE));
  const bh = Math.max(1, Math.round(h * BUFFER_SCALE));
  const buf = getBuffer(bw, bh);

  if (!buf) {
    // запасний шлях, якщо офскрін-канвас із якоїсь причини недоступний:
    // та сама пара функцій напряму на головному канвасі, просто дорожче
    ctx.save();
    ctx.filter = `blur(${(BLUR_PX * dpr).toFixed(2)}px)`;
    drawSky(ctx, w, h, 1);
    drawClouds(ctx, w, h, clock, 1);
    ctx.filter = 'none';
    ctx.restore();
    return;
  }

  const { canvas: bc, ctx: bctx } = buf;
  // буфер — свіжий canvas щоразу як міняється розмір, і transform на ньому
  // завжди тотожний: жодного dpr-масштабування, малюємо прямо в його пікселі
  bctx.save();
  bctx.filter = `blur(${(BLUR_PX * BUFFER_SCALE * dpr).toFixed(2)}px)`;
  drawSky(bctx, bw, bh, BUFFER_SCALE);
  drawClouds(bctx, bw, bh, clock, BUFFER_SCALE);
  bctx.filter = 'none';
  bctx.restore();

  // один дешевий drawImage розтягує буфer на весь кадр; згладжування
  // (тимчасово увімкнене саме на цей виклик) додає ще трохи м'якості
  ctx.save();
  const smoothed = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(bc, 0, 0, w, h);
  ctx.imageSmoothingEnabled = smoothed;
  ctx.restore();
}
