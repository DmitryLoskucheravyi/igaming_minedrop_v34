/* ============================================================
   ASSETS — вантажить картинки, шляхи до яких прописані
   в конфізі рушія (BLOCKS[*].skin, TIERS[*].skin/skinMagic).

   Хочеш замінити скін — міняєш шлях у packages/engine/src/config.ts,
   більше ніде. Файл не знайшовся — малюється заглушка, гра не падає.

   ЧОМУ ЗАВАНТАЖЕННЯ РОЗДІЛЕНЕ НАДВОЄ
   Зачаровані скіни (`_magic`) важать разом ~14 МБ — від 1.5 до 6.3 МБ
   кожен. На десктопі це непомітно, у телеграмі на мобільному
   інтернеті це 14 МБ ДО першого кадру: гравець піде раніше, ніж
   побачить рулетку.

   Тому:
     - блокуючий етап — тільки блоки й звичайні кірки (~40 КБ);
     - зачаровані вантажаться у фоні одразу після старту, а якщо
       верстак трапився раніше, ніж вони доїхали, малюється
       звичайний скін — гра від цього не ламається.

   Це прибирає затримку старту, але не трафік. Файли все одно
   варто перетиснути: 6.3 МБ на одну анімацію кірки — це
   повнорозмірний оригінал там, де треба ~256px.
   ============================================================ */

import { BLOCKS, TIERS, type Tier } from '@minedrop/engine';

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
    p['reelFrame'] = '/рамка.png';   // декоративна рамка вікна рулетки, прозорий центр
    /* Другий скін каменю. Це НЕ окремий блок: та сама клітинка stone,
       просто з глибиною вона частіше малюється булижником (див.
       Render.block). Тому шляху немає в BLOCKS — він тільки тут. */
    p['block.stone2'] = '/камінь2.png';
    /* Огорожа поля. Теж не блок у сітці: межа шахти й так існує у
       фізиці (Mine.get повертає WALL за краєм), огорожа лише робить
       її видимою. */
    p['fence'] = '/стіна.jpg';
    return p;
  }

  /* Іконки валют для попапів/тостів. Не потрібні для першого кадру
     (екран завантаження), тому вантажаться у фоні — до першого
     розбитого блоку встигають, а Render.money їх відсутність
     переживає (малює лише текст). */
  private loadCurrencies(): Promise<void[]> {
    return Promise.all([
      this.one('cur.RUB', '/rub.png'),
      this.one('cur.USDT', '/usdt.png'),
      this.one('cur.XTR', '/зірка.png'),
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

    // важке й другорядне — у фон, не чекаючи
    void this.loadMagic();
    void this.loadCurrencies();
  }

  /** Зачаровані скіни. Помилка тут не критична — є запасний варіант. */
  private loadMagic(): Promise<void[]> {
    return Promise.all(TIERS.map((t) => this.one('pickm.' + t.id, t.skinMagic)));
  }

  get(key: string): HTMLImageElement | null {
    return this.images[key] ?? null;
  }

  /* Кірка: зачарована версія після верстака, звичайна — до нього
     або поки зачарована ще не доїхала. */
  pick(tier: Tier, enchanted: boolean): HTMLImageElement | null {
    if (!enchanted) return this.get('pick.' + tier.id);
    const key = 'pickm.' + tier.id;
    if (!(key in this.images)) void this.one(key, tier.skinMagic);   // ще не починали
    return this.get(key) ?? this.get('pick.' + tier.id);
  }
}

export const Assets = new AssetStore();
