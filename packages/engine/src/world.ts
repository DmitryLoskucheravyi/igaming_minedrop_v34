/* ============================================================
   WORLD — нескінченна шахта. Ряди генеруються на льоту, старі
   викидаються. Ніякого малювання — щоб можна було ганяти в node.

   Клітинка = null (порожньо) або { id, dmg, seed, m }, де dmg —
   накопичений урон (для тріщин і поступового розколу).

   ЧОМУ РЯД СІЄТЬСЯ ОКРЕМО
   Кожен ряд генерується з rowRng(root, r) — тобто залежить тільки
   від номера ряду. Це не оптимізація, а вимога коректності: клієнт
   малює ряди наперед (видима частина екрана), сервер їх не чіпає
   зовсім, і якби ряди бралися зі спільного послідовного потоку,
   шахта на клієнті вийшла б іншою, ніж на сервері.
   ============================================================ */

import { BLOCKS, CONFIG, depthWeights } from './config';
import { pickWeighted, pickWeightedKey, rowRng, type Rng } from './rng';
import type { BlockId } from './types';

export interface Cell {
  id: BlockId;
  dmg: number;      // накопичений урон
  seed: number;     // щоб малюнок тріщин був сталий, а не миготів
  m?: number;       // множник, якщо це Х-блок
}

/* Межа шахти. Окремий об'єкт, щоб відрізняти від порожньої клітинки. */
export const WALL = { wall: true } as const;
export type WallCell = typeof WALL;

export class Mine {
  readonly cols: number;
  readonly bonus: boolean;
  readonly root: number;
  readonly rows = new Map<number, (Cell | null)[]>();
  deepest = 0;

  /** root — корінь порядкового сида (streamRoot(seed, 'mine')) */
  constructor(cols: number, root: number, bonus: boolean) {
    this.cols = cols || CONFIG.cols;
    this.root = root | 0;
    this.bonus = !!bonus;
  }

  genRow(r: number): (Cell | null)[] {
    const w = depthWeights(r, this.bonus);
    const rnd: Rng = rowRng(this.root, r);
    const row: (Cell | null)[] = new Array(this.cols);

    for (let c = 0; c < this.cols; c++) {
      const k = pickWeightedKey(w, rnd, 'stone');
      if (k === 'air') { row[c] = null; continue; }
      const cell: Cell = {
        id: k as BlockId,
        dmg: 0,
        seed: ((r * 73856093) ^ (c * 19349663)) & 0x7fffffff,
      };
      if (k === 'mult') cell.m = pickWeighted(CONFIG.bonus.multTable, rnd).m;
      row[c] = cell;
    }
    return row;
  }

  row(r: number): (Cell | null)[] {
    let row = this.rows.get(r);
    if (!row) { row = this.genRow(r); this.rows.set(r, row); }
    if (r > this.deepest) this.deepest = r;
    return row;
  }

  /** null = порожньо, WALL = за межами шахти, інакше клітинка */
  get(r: number, c: number): Cell | null | WallCell {
    if (c < 0 || c >= this.cols) return WALL;
    if (r < 0) return null;
    return this.row(r)[c];
  }

  clear(r: number, c: number): Cell | null {
    if (c < 0 || c >= this.cols || r < 0) return null;
    const row = this.row(r);
    const cell = row[c];
    row[c] = null;
    return cell;
  }

  /* Викидаємо ряди, що лишились далеко вгорі — щоб пам'ять не росла.

     УВАГА: це знищує стан ряду. Відновиться він з нуля — цілі блоки,
     тріщин нема. Тому напряму цей метод кликати не можна; межу рахує
     Run.pruneMine() від найвищої ЖИВОЇ кірки. */
  prune(aboveRow: number): void {
    for (const r of this.rows.keys()) if (r < aboveRow) this.rows.delete(r);
  }
}

export const isWall = (v: Cell | null | WallCell): v is WallCell => v === WALL;
export const blockOf = (cell: Cell) => BLOCKS[cell.id];
