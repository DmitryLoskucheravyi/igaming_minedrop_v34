/* ============================================================
   ASSETS — вантажить картинки, шляхи до яких прописані
   в config.js (BLOCKS[*].skin, TIERS[*].skin/skinMagic).

   Хочеш замінити скін — міняєш шлях у config.js, більше ніде.
   Файл не знайшовся — малюється заглушка, гра не падає.
   ============================================================ */
const Assets = {
  images: {},
  missing: [],
  ready: false,

  paths() {
    const p = {};
    TIERS.forEach(t => {
      p['pick.' + t.id] = t.skin;
      p['pickm.' + t.id] = t.skinMagic;
    });
    Object.keys(BLOCKS).forEach(b => { p['block.' + b] = BLOCKS[b].skin; });
    return p;
  },

  load(done, onProgress) {
    const paths = this.paths();
    const keys = Object.keys(paths).filter(k => paths[k]);
    let left = keys.length, total = keys.length;
    if (!left) { this.ready = true; return done(); }

    keys.forEach(k => {
      const img = new Image();
      const finish = (ok) => {
        this.images[k] = ok ? img : null;
        if (!ok) this.missing.push(paths[k]);
        if (onProgress) onProgress(total - left + 1, total);
        if (--left === 0) {
          this.ready = true;
          if (this.missing.length) console.warn('Не знайдено скінів:', this.missing);
          done();
        }
      };
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = paths[k];
    });
  },

  get(key) { return this.images[key] || null; },

  /* Кірка: зачарована версія після верстака, звичайна — до нього */
  pick(tier, enchanted) {
    return (enchanted && this.get('pickm.' + tier.id)) || this.get('pick.' + tier.id);
  }
};
