/* ============================================================
   BACKDROP — намальований фон (public/background.png) і хмари, що
   пливуть поверх нього.

   ЩО ЗМІНИЛОСЬ
   Раніше все небо було процедурним: градієнт-заливка + хмари з
   ASCII-масивів + Gaussian blur в офскрін-буфері. Тепер фон — одна
   готова піксель-арт картинка 320x320 (небо з хмарами, гори, ліс,
   річка), а рухомі хмари — окремі спрайти. Тому звідси зникли
   SKY_STOPS, CLOUD_SPRITES, TONE, paintSprite(), drawCloudSprite() і
   весь буфер із розмиттям: малюнок уже зроблений художником, розмивати
   його — значить псувати.

   ЕКРАННИЙ ШАР, А НЕ СВІТОВИЙ
   Як і раніше: фон живе в координатах ЕКРАНА. Скільки не копай
   углиб — та сама картинка на тому самому місці. Хмари пливуть по
   годиннику (clock), а не по позиції кірки.

   Малюється ПЕРШИМ, до самої шахти: блоки й огорожа лягають зверху й
   ховають фон там, де порода ціла. Видно його тільки в порожнечі —
   над полем і в тунелі, який прокопала кірка.

   ПІКСЕЛЬ ЛИШАЄТЬСЯ ПІКСЕЛЕМ
   Згладжування вимкнене (Render.pixelate у presenter вимикає його на
   весь кадр), а масштаб береться ЦІЛИЙ у пікселях ПРИСТРОЮ — див.
   coverScale(). Дробовий масштаб на nearest-neighbour дає рвані
   сходинки різної ширини, і рівний піксельний растр розсипається.
   ============================================================ */

import { Assets } from './assets';

type Ctx = CanvasRenderingContext2D;

/* ---------------- фон ---------------- */

/** Розмір background.png. Квадрат — заміряно з файлу. */
const BG_SIZE = 320;

/* Куди пришпилити картинку по вертикалі.

   BG_ANCHOR — точка САМОЇ картинки (частка її висоти), BG_SCREEN —
   куди вона має потрапити на екрані (частка висоти кадру). 0.62 —
   лінія, де гори переходять у долину; 0.55 — трохи вище за середину
   екрана. Разом це і є вимога «горизонт лишається видимим у верхній
   частині»: небо з горами займає верхні ~55% кадру, а нижче йде
   поверхня, куди стає шахта.

   Обидва числа підібрані на око по самій картинці — точнішого
   критерію тут не буває, лінія горизонту на ній не пряма. */
const BG_ANCHOR = 0.62;
const BG_SCREEN = 0.55;

/* Легке затемнення поверх фону. Картинка яскрава й контрастна, а над
   нею живуть HUD і темна шахта; без цього фон перетягує увагу на себе.
   Дешева заміна колишньому блюру: один fillRect замість Gaussian. */
const BG_DIM = 'rgba(0,0,0,.12)';

/* Масштаб «cover»: покрити весь кадр без полів і без спотворення
   пропорцій. Округлюємо ВГОРУ до цілого числа пікселів ПРИСТРОЮ —
   тоді один піксель картинки = ціла кількість фізичних пікселів, і
   nearest-neighbour дає рівний растр. Вгору, а не до найближчого:
   округлення вниз лишило б смугу порожнечі скраю. */
function coverScale(w: number, h: number, dpr: number): number {
  const need = Math.max(w / BG_SIZE, h / BG_SIZE);
  return Math.ceil(need * dpr) / dpr;
}

/** Округлення до сітки фізичних пікселів — щоб зсув не з'їдав ряд. */
function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

function drawBackground(ctx: Ctx, w: number, h: number, dpr: number): void {
  const img = Assets.get('bg');
  if (!img) {
    // картинка не доїхала — рівне небо, щоб кадр не був порожнім
    ctx.fillStyle = '#6bb0ef';
    ctx.fillRect(0, 0, w, h);
    return;
  }

  const s = coverScale(w, h, dpr);
  const size = BG_SIZE * s;
  const x = snap((w - size) / 2, dpr);
  /* Верхній край не можна опустити нижче 0 (з'явилась би смуга над
     картинкою), а нижній — підняти вище h. Між цими межами ставимо
     BG_ANCHOR у BG_SCREEN. */
  const wanted = h * BG_SCREEN - size * BG_ANCHOR;
  const y = snap(Math.max(Math.min(wanted, 0), Math.min(h - size, 0)), dpr);

  ctx.drawImage(img, x, y, size, size);
  ctx.fillStyle = BG_DIM;
  ctx.fillRect(0, 0, w, h);
}

/* ---------------- хмари ---------------- */

/* Три картинки (public/sky/cloud-*.png). Дві з них намальовані
   вертикально й повертаються на 90° ПРОТИ годинникової — один раз при
   першому кадрі, у офскрін-canvas (див. Assets.rotCCW). Щокадровий
   ctx.rotate коштував би save/rotate/restore на кожну хмару.

   Розміри після повороту (заміряно з файлів):
     cloud-1  1198x310  (вже горизонтальна, не повертаємо)
     cloud-2   560x211  (у файлі 211x560)
     cloud-3   560x331  (у файлі 331x560) */
const CLOUD_KEYS = ['cloud1', 'cloud2', 'cloud3'] as const;
const CLOUD_ROTATE = [false, true, true] as const;

/* Хмари, ЩО ВЖЕ НАМАЛЬОВАНІ на background.png, лишаються частиною
   фону. Рухомі не мають із ними змагатись, тому:
     - тримаємо їх ВИЩЕ (yFrac до ~0.30, тобто у верхній частині неба);
     - малюємо трохи прозоріше (CLOUD_ALPHA).
   Прозорість спільна, щоб шар читався як один шар. */
const CLOUD_ALPHA = 0.88;

/* Конфіг хмар. Розкидані свідомо по всіх трьох осях — по горизонталі
   (phase), по вертикалі (yFrac) і за розміром (wFrac), — щоб небо не
   читалось як один конвеєр однакових плям.

   wFrac — ширина хмари в частках ШИРИНИ ЕКРАНА (не в пікселях): на
   вузькому телефоні й на десктопі хмара займає ту саму частку неба.
   speed — px/сек екранного дрейфу, СТРОГО зліва направо (x росте).
   Дальній шар (дрібніші хмари, вище) їде повільніше — паралакс. */
interface CloudCfg {
  sprite: 0 | 1 | 2;
  yFrac: number;      // верх хмари, частка висоти екрана
  wFrac: number;      // ширина, частка ширини екрана
  speed: number;      // px/сек
  phase: number;      // зсув старту, px
}
const CLOUDS: readonly CloudCfg[] = [
  // ближній шар — більші й швидші
  { sprite: 0, yFrac: 0.06, wFrac: 0.42, speed: 18, phase: 0 },
  { sprite: 2, yFrac: 0.20, wFrac: 0.30, speed: 15, phase: 260 },
  { sprite: 1, yFrac: 0.13, wFrac: 0.34, speed: 16, phase: 620 },
  // середній
  { sprite: 1, yFrac: 0.27, wFrac: 0.24, speed: 11, phase: 140 },
  { sprite: 0, yFrac: 0.02, wFrac: 0.26, speed: 12, phase: 480 },
  { sprite: 2, yFrac: 0.31, wFrac: 0.21, speed: 10, phase: 820 },
  // дальній — найдрібніші й найповільніші
  { sprite: 1, yFrac: 0.10, wFrac: 0.16, speed: 7, phase: 360 },
  { sprite: 0, yFrac: 0.23, wFrac: 0.18, speed: 6, phase: 700 },
];

function drawClouds(ctx: Ctx, w: number, h: number, clock: number): void {
  ctx.save();
  ctx.globalAlpha = CLOUD_ALPHA;
  for (const cfg of CLOUDS) {
    const key = CLOUD_KEYS[cfg.sprite];
    const art: HTMLCanvasElement | HTMLImageElement | null =
      CLOUD_ROTATE[cfg.sprite] ? Assets.rotCCW(key) : Assets.get(key);
    if (!art) continue;
    // повернута хмара — canvas (у нього тільки width/height), звичайна — <img>
    const nw = art instanceof HTMLCanvasElement ? art.width : (art.naturalWidth || art.width);
    const nh = art instanceof HTMLCanvasElement ? art.height : (art.naturalHeight || art.height);
    if (!nw || !nh) continue;

    const cw = w * cfg.wFrac;
    const ch = cw * (nh / nw);
    /* Нескінченний дрейф УПРАВО: вийшла за правий край — заходить
       зліва. span більший за екран рівно на дві ширини хмари, тому
       поява й зникнення відбуваються за кадром. */
    const span = w + cw * 2;
    const x = ((clock * cfg.speed + cfg.phase) % span) - cw;
    ctx.drawImage(art, Math.round(x), Math.round(cfg.yFrac * h), Math.round(cw), Math.round(ch));
  }
  ctx.restore();
}

/* ---------------- вхідна точка ---------------- */

/* dpr потрібен ЛИШЕ для вирівнювання фону по сітці фізичних пікселів
   (канвас під капотом масштабований на dpr — див. Presenter.layout).
   Розмиття, заради якого його брали раніше, більше немає. */
export function drawBackdrop(ctx: Ctx, w: number, h: number, clock: number, dpr: number): void {
  drawBackground(ctx, w, h, dpr);
  drawClouds(ctx, w, h, clock);
}
