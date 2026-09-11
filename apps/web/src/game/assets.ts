/* ============================================================
   ASSETS — вантажить картинки, шляхи до яких прописані
   в конфізі рушія (BLOCKS[*].skin, TIERS[*].skin).

   Хочеш замінити скін кірки чи блоку — міняєш шлях у
   packages/engine/src/config.ts, більше ніде. Файл не знайшовся —
   малюється заглушка, гра не падає.

   Решта (фон, хмари, кільце рулетки, тріщини, ефекти) — не блоки й не
   кірки, у рушії їм не місце: їхні шляхи живуть тут, у corePaths() і
   loadExtras().

   ЧОМУ ЗАВАНТАЖЕННЯ РОЗДІЛЕНЕ НАДВОЄ
   Поділ за ПОТРІБНІСТЮ ДО ПЕРШОГО КАДРУ, а не просто за вагою:

     - блокуючий етап — усе, що видно на екрані рулетки одразу: фон,
       хмари, кільце з підкладкою, символи стрічки, блоки декоративної
       шахти, кірки, тріщини (~2 МБ реального піксель-арту);
     - фоновий — те, чого в першому кадрі немає фізично: іконки валют
       (з'являються з першим розбитим блоком) і важкі спрайти ефектів
       (вибух TNT, шлейфи кірки — разом ~320 КБ). Поки вони їдуть,
       ефект просто не малюється, а гра від цього не ламається.

   Раніше причина поділу була інша — зачаровані скіни кірок важили
   разом ~14 МБ і тягнулись ДО першого кадру. Зачарування прибрано як
   механіку, скіни видалено, і ділити «за вагою» більше нема чого;
   поділ лишився, але тепер він саме про потрібність до першого кадру.
   ============================================================ */

import { BLOCKS, TIERS, type Tier } from '@minedrop/engine';

/* Яку частку СВОГО ПОЛОТНА займає малюнок кірки — заміряно по
   альфа-каналу кожного файлу.

   Навіщо це взагалі: Render.pickaxe отримує ВИДИМИЙ розмір кірки, а
   не розмір полотна. Полотно = видимий розмір / fill. Без цього кожна
   заміна скіну з іншими полями мовчки міняла б масштаб кірки на полі —
   рівно те, що сталося при переході на нові 256x256 (малюнок впритул
   до країв, 1.00 полотна) з попередніх 160x160 (bbox 130x130 = 0.8125).

   Зараз ВСІ скіни намальовані від краю до краю, тож у мапі порожньо і
   всі беруть 1.0. Мапу лишено навмисно: щойно з'явиться скін із
   полями, його частка вписується сюди одним рядком — і масштаб кірки
   на полі не поїде. Так, наприклад, тут жила золота кірка зі старого
   комплекту 160x160 (bbox 130x130 = 0.8125), поки її не прибрали. */
const PICK_FILL_DEFAULT = 1;
const PICK_FILL: Partial<Record<string, number>> = {};

class AssetStore {
  images: Record<string, HTMLImageElement | null> = {};
  missing: string[] = [];
  ready = false;

  private pending = new Map<string, Promise<void>>();

  /** Те, без чого не можна малювати перший кадр */
  private corePaths(): Record<string, string> {
    const p: Record<string, string> = {};
    for (const t of TIERS) p['pick.' + t.id] = t.skin;
    for (const key of Object.keys(BLOCKS) as (keyof typeof BLOCKS)[]) {
      const skin = BLOCKS[key].skin;
      if (skin) p['block.' + key] = skin;
    }

    /* Фон екрана — намальована картинка 320x320 замість колишнього
       процедурного неба. Саме БЛОКУЮЧИЙ етап: без неї перший кадр
       порожній (див. backdrop.ts). */
    p['bg'] = '/background.png';
    /* Хмари, що пливуть поверх фону. Дві з трьох намальовані
       вертикально — повертає їх rotCCW() нижче. */
    p['cloud1'] = '/sky/cloud-1.png';
    p['cloud2'] = '/sky/cloud-2.png';
    p['cloud3'] = '/sky/cloud-3.png';

    /* Кільце слот-машини. У ньому ВИРІЗАНО сім сегментів прогресу до
       гарантованої кірки — вони прозорі, і колір їм дає заливка ПІД
       кільцем (див. drawSegments у reel.ts). Окремих картинок-паличок
       на сегмент більше немає: /ui/pip-*.png лишились у репо, але вже
       нікуди не підключені. */
    p['reelRing'] = '/ui/reel-frame.png';
    // темний диск ПІД стрічкою, малюється всередині вирізу кільця
    p['reelBacking'] = '/ui/reel-backing.png';
    // «пусто» на стрічці
    p['reelNothing'] = '/ui/reel-nothing.png';
    // сердечко в підписі HP над кіркою
    p['heart'] = '/ui/heart.png';
    // растровий шрифт цифр для попапів виграшу
    p['popupFont'] = '/ui/popup-font.png';
    // табличка виграшу й слово WIN (обидві намальовані вертикально)
    p['winBanner'] = '/ui/win-banner.png';
    p['winWord'] = '/ui/win-word.png';

    /* Другий скін каменю. Це НЕ окремий блок: та сама клітинка stone,
       просто з глибиною вона частіше малюється булижником (див.
       Render.block). Тому шляху немає в BLOCKS — він тільки тут. */
    p['block.stone2'] = '/blocks/cobble.png';
    /* Огорожа поля. Теж не блок у сітці: межа шахти й так існує у
       фізиці (Mine.get повертає WALL за краєм), огорожа лише робить
       її видимою. */
    p['fence'] = '/blocks/wall.png';

    /* Руда заліза/золота/редстоуну — НАКЛАДКИ на булижник, а не
       самостійні картинки блоку: спершу малюється cobble, зверху
       накладка (див. Render.block). Тому вони й не в BLOCKS[*].skin —
       там у всіх трьох стоїть той самий булижник. */
    p['ore.iron'] = '/blocks/ore-iron-overlay.png';
    p['ore.gold'] = '/blocks/ore-gold-overlay.png';
    p['ore.redstone'] = '/blocks/ore-redstone-overlay.png';

    // чотири стадії тріщин; потрібні з першого ж удару по руді
    for (let i = 1; i <= 4; i++) p['crack' + i] = '/fx/crack-' + i + '.png';

    return p;
  }

  /* Другорядне: іконки валют для попапів/тостів і важкі спрайти
     ефектів. Для першого кадру не потрібні жодні — до першого
     розбитого блоку встигають, а їхню відсутність усі викликачі
     переживають (Render.money малює лише текст, ефект не малюється). */
  private loadExtras(): Promise<unknown> {
    return Promise.all([
      this.one('cur.RUB', '/coins/rub.png'),
      this.one('cur.USDT', '/coins/usdt.png'),
      this.one('cur.XTR', '/coins/xtr.png'),
      this.one('fx.tntBlast', '/fx/tnt-blast.png'),
      this.one('fx.pickGrow', '/fx/pick-grow.png'),
      this.one('fx.pickTnt', '/fx/pick-tnt.png'),
      this.one('fx.pickWorkbench', '/fx/pick-workbench.png'),
    ]);
  }

  /* Одноколірні іконки (значок рубля) тонуються в колір тексту.
     Тонована версія кешується за парою ключ+колір — кольорів мало
     (кольори блоків + золото), тож мапа лишається крихітною. */
  private tints = new Map<string, HTMLCanvasElement>();

  tint(key: string, color: string): CanvasImageSource | null {
    const img = this.get(key);
    if (!img) return null;
    const ck = key + '|' + color;
    const hit = this.tints.get(ck);
    if (hit) return hit;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return img;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) return img;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    this.tints.set(ck, c);
    return c;
  }

  /* Частина картинок намальована ВЕРТИКАЛЬНО й має лежати боком
     (хмари 2-3, табличка виграшу, слово WIN). Повертаємо їх РІВНО ОДИН
     раз — у офскрін-canvas, при першому ж використанні, — і кешуємо.
     Альтернатива (save/rotate/drawImage/restore щокадру на кожну
     хмару) коштує тих самих пікселів помножених на 60 кадрів/с.

     Згладжування вимкнене: поворот рівно на 90° точний, але браузер
     усе одно проганяє його через ресемплінг, якщо дозволити. */
  private rotated = new Map<string, HTMLCanvasElement>();

  rotCCW(key: string): HTMLCanvasElement | null {
    const hit = this.rotated.get(key);
    if (hit) return hit;
    const img = this.get(key);
    if (!img) return null;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;

    const c = document.createElement('canvas');
    c.width = h;                       // 90° — сторони міняються місцями
    c.height = w;
    const g = c.getContext('2d');
    if (!g) return null;
    g.imageSmoothingEnabled = false;
    g.translate(0, c.height);
    g.rotate(-Math.PI / 2);            // проти годинникової = «вліво»
    g.drawImage(img, 0, 0);
    this.rotated.set(key, c);
    return c;
  }

  private one(key: string, src: string): Promise<void> {
    const started = this.pending.get(key);
    if (started) return started;

    const p = new Promise<void>((resolve) => {
      const img = new Image();
      const finish = (ok: boolean) => {
        this.images[key] = ok ? img : null;
        if (!ok) this.missing.push(src);
        resolve();
      };
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = src;
    });
    this.pending.set(key, p);
    return p;
  }

  /** Блокуючий етап. Резолвиться, коли можна показувати гру. */
  async load(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.ready) return;
    const paths = this.corePaths();
    const keys = Object.keys(paths);
    let done = 0;

    await Promise.all(keys.map((k) =>
      this.one(k, paths[k]).then(() => onProgress?.(++done, keys.length))));

    this.ready = true;
    if (this.missing.length) console.warn('Не знайдено скінів:', this.missing);

    // другорядне — у фон, не чекаючи
    void this.loadExtras();
  }

  get(key: string): HTMLImageElement | null {
    return this.images[key] ?? null;
  }

  pick(tier: Tier): HTMLImageElement | null {
    return this.get('pick.' + tier.id);
  }

  /** Частка полотна, яку займає сам малюнок кірки — див. PICK_FILL. */
  pickFill(tier: Tier): number {
    return PICK_FILL[tier.id] ?? PICK_FILL_DEFAULT;
  }
}

export const Assets = new AssetStore();
