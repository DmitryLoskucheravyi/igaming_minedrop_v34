/* ============================================================
   WORLD — нескінченна шахта. Ряди генеруються на льоту, старі
   викидаються. Ніякого малювання — щоб можна було ганяти в node.

   Клітинка = null (порожньо) або { id, hits }, де hits — скільки
   ударів блок уже отримав (для тріщин і поступового розколу).
   ============================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined') {
    const c = require('./config.js');
    module.exports = factory(c.CONFIG, c.BLOCKS, c.depthWeights);
  } else {
    root.World = factory(CONFIG, BLOCKS, depthWeights);
  }
})(typeof self !== 'undefined' ? self : this, function (CONFIG, BLOCKS, depthWeights) {

  /* Зважений вибір ключа з {key: weight} */
  function pickKey(weights, rnd) {
    let total = 0;
    for (const k in weights) total += weights[k];
    let x = (rnd || Math.random)() * total;
    for (const k in weights) { x -= weights[k]; if (x <= 0) return k; }
    return 'stone';
  }

  /* Зважений вибір елемента масиву за полем .weight */
  function pickItem(arr, rnd) {
    let total = 0;
    for (const it of arr) total += it.weight;
    let x = (rnd || Math.random)() * total;
    for (const it of arr) { x -= it.weight; if (x <= 0) return it; }
    return arr[arr.length - 1];
  }

  /* Межа шахти. Окремий об'єкт, щоб відрізняти від порожньої клітинки. */
  const WALL = { wall: true };

  class Mine {
    constructor(cols, rnd, bonus) {
      this.cols = cols || CONFIG.cols;
      this.rnd = rnd || Math.random;
      this.bonus = !!bonus;          // у бонусній шахті додатково є блоки-множники
      this.rows = new Map();
      this.deepest = 0;
    }

    genRow(r) {
      const w = depthWeights(r, this.bonus);
      const row = new Array(this.cols);
      for (let c = 0; c < this.cols; c++) {
        const k = pickKey(w, this.rnd);
        if (k === 'air') { row[c] = null; continue; }
        // dmg — накопичений урон, seed — щоб малюнок тріщин був сталий, а не миготів
        const cell = { id: k, dmg: 0, seed: ((r * 73856093) ^ (c * 19349663)) & 0x7fffffff };
        if (k === 'mult') cell.m = pickItem(CONFIG.bonus.multTable, this.rnd).m;
        row[c] = cell;
      }
      return row;
    }

    row(r) {
      let row = this.rows.get(r);
      if (!row) { row = this.genRow(r); this.rows.set(r, row); }
      if (r > this.deepest) this.deepest = r;
      return row;
    }

    /* null = порожньо, WALL = за межами шахти, інакше клітинка {id, hits} */
    get(r, c) {
      if (c < 0 || c >= this.cols) return WALL;
      if (r < 0) return null;
      return this.row(r)[c];
    }

    clear(r, c) {
      if (c < 0 || c >= this.cols || r < 0) return null;
      const row = this.row(r);
      const cell = row[c];
      row[c] = null;
      return cell;
    }

    /* Викидаємо ряди, що лишились далеко вгорі — щоб пам'ять не росла */
    prune(aboveRow) {
      for (const r of this.rows.keys()) if (r < aboveRow) this.rows.delete(r);
    }
  }

  return { Mine, pickKey, pickItem, WALL };
});
