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

   РУДА ЛЯГАЄ ПОКЛАДАМИ, А НЕ ПОКЛІТИННО
   Той самий принцип, тільки одиницею детермінізму є не ряд, а РЕГІОН
   (ORE_REGION_ROWS рядів). Поклад — суцільна пляма клітинок, і його
   форма/наявність залежить ЛИШЕ від (root, номер регіону, тип руди) —
   жодної залежності від сусідніх рядів чи порядку запитів. Числа й
   механіка форми — у config.ts (ORE_VEINS).
   ============================================================ */

import {
  BLOCKS, CONFIG, MULT_TABLE_BONUS, depthWeights, ORE_REGION_ROWS, ORE_VEINS, type VeinSpec,
} from './config';
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

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/* Порядок фіксований і впливає лише на те, хто «забирає» клітинку
   першим, якщо два поклади випадково перетнулись, — не на чесність
   чи детермінізм, аби порядок завжди був той самий. */
const ORE_ORDER: BlockId[] = ['coal', 'iron', 'lapis', 'redstone', 'gold', 'diamond', 'emerald'];
const DIRS: readonly [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

/* Великий зсув, щоб «номер регіону», переданий у rowRng як «номер
   ряду», ніколи не збігався зі справжнім номером ряду (той — окремий
   простір значень, використовується для фонових блоків). */
const ORE_SEED_BASE = 1_000_000;

/** Один поклад: суцільна пляма, що росте випадковим блуканням від
    центру. Детермінований лише від (root, regionId, тип руди). */
function placeVein(
  root: number, regionId: number, oreIndex: number, oreId: BlockId, spec: VeinSpec,
  cols: number, oreMap: Map<string, BlockId>,
): void {
  const regionStart = regionId * ORE_REGION_ROWS;
  const midRow = regionStart + ORE_REGION_ROWS / 2;
  const rnd: Rng = rowRng(root, ORE_SEED_BASE + regionId * 8 + oreIndex);

  if (rnd() >= spec.chance(midRow)) return;   // покладу в цьому регіоні нема

  const size = spec.min + Math.floor(rnd() * (spec.max - spec.min + 1));
  const r0 = regionStart + Math.floor(rnd() * ORE_REGION_ROWS);
  const c0 = Math.floor(rnd() * cols);

  /* Третє число у вузлі — скільки спроб рости з нього вже провалилось.
     Раніше вузол викидався після ПЕРШОГО ж невдалого напрямку з чотирьох,
     тому фронт танув набагато швидше, ніж поклад устигав дорости, і
     реальні розміри систематично не дотягували до spec.min/max. Тепер
     вузол лишається у фронті, доки не провалиться DIRS.length спроб. */
  const frontier: [number, number, number][] = [];
  const key0 = r0 + ',' + c0;
  let placed = 0;
  if (!oreMap.has(key0)) { oreMap.set(key0, oreId); frontier.push([r0, c0, 0]); placed = 1; }

  let guard = size * 20;   // страховка від зависання в затиснутому регіоні
  while (placed < size && frontier.length && guard-- > 0) {
    const idx = Math.floor(rnd() * frontier.length);
    const node = frontier[idx];
    const [dr, dc] = DIRS[Math.floor(rnd() * DIRS.length)];
    const nr = clamp(node[0] + dr, regionStart, regionStart + ORE_REGION_ROWS - 1);
    const nc = clamp(node[1] + dc, 0, cols - 1);
    const key = nr + ',' + nc;
    if (!oreMap.has(key)) {
      oreMap.set(key, oreId);
      frontier.push([nr, nc, 0]);
      placed++;
    } else if (++node[2] >= DIRS.length) {
      frontier.splice(idx, 1);   // усі напрямки з цього вузла вичерпані
    }
  }
}

/** Усі поклади руди в одному регіоні. Чиста функція (root, regionId, cols). */
function regionOreMap(root: number, regionId: number, cols: number): Map<string, BlockId> {
  const oreMap = new Map<string, BlockId>();
  ORE_ORDER.forEach((oreId, i) => {
    const spec = ORE_VEINS[oreId];
    if (spec) placeVein(root, regionId, i, oreId, spec, cols, oreMap);
  });
  return oreMap;
}

export class Mine {
  readonly cols: number;
  readonly root: number;
  readonly rows = new Map<number, (Cell | null)[]>();

  /* Найвища межа ЖИВОЇ шахти: усе, що вище, вже викинуто prune(), і
     відновлювати його не можна ні у фізиці, ні на екрані — ряд
     згенерується з нуля, цілими блоками, і діри від кірки й TNT
     «заростуть». Потрібно саме peek() (див. нижче). */
  private prunedAbove = -Infinity;

  /* Регіони покладів руди — окремий, набагато дрібніший кеш від `rows`:
     не пруниться (розмір тривіальний навіть на довгий забіг), існує
     тільки щоб не перераховувати той самий регіон на кожен запитаний
     у ньому ряд. */
  private readonly oreCache = new Map<number, Map<string, BlockId>>();

  /** Бонусна шахта (куплена кірка): щедріші ваги множників і столів
      зачарування. Прапорець зберігається на шахті, бо ряди генеруються
      лениво — і клієнт мусить будувати їх із тим самим значенням. */
  readonly bonus: boolean;

  /** root — корінь порядкового сида (streamRoot(seed, 'mine')) */
  constructor(cols: number, root: number, bonus = false) {
    this.cols = cols || CONFIG.cols;
    this.root = root | 0;
    this.bonus = bonus;
  }

  private oreMapFor(regionId: number): Map<string, BlockId> {
    let m = this.oreCache.get(regionId);
    if (!m) { m = regionOreMap(this.root, regionId, this.cols); this.oreCache.set(regionId, m); }
    return m;
  }

  genRow(r: number): (Cell | null)[] {
    const w = depthWeights(r, this.bonus);
    const rnd: Rng = rowRng(this.root, r);
    const row: (Cell | null)[] = new Array(this.cols);

    const oreMap = this.oreMapFor(Math.floor(r / ORE_REGION_ROWS));

    for (let c = 0; c < this.cols; c++) {
      const ore = oreMap.get(r + ',' + c);
      const k = ore ?? (pickWeightedKey(w, rnd, 'stone') as BlockId | 'air');
      if (k === 'air') { row[c] = null; continue; }
      const cell: Cell = {
        id: k as BlockId,
        dmg: 0,
        seed: ((r * 73856093) ^ (c * 19349663)) & 0x7fffffff,
      };
      // у бонусці великі ікси важчі — див. MULT_TABLE_BONUS
      if (k === 'mult') {
        cell.m = pickWeighted(this.bonus ? MULT_TABLE_BONUS : CONFIG.mult.table, rnd).m;
      }
      row[c] = cell;
    }
    return row;
  }

  row(r: number): (Cell | null)[] {
    let row = this.rows.get(r);
    if (!row) { row = this.genRow(r); this.rows.set(r, row); }
    return row;
  }

  /** null = порожньо, WALL = за межами шахти, інакше клітинка */
  get(r: number, c: number): Cell | null | WallCell {
    if (c < 0 || c >= this.cols) return WALL;
    if (r < 0) return null;
    return this.row(r)[c];
  }

  /** Читання для РЕНДЕРА: те саме, що get(), але ніколи не перетворює
      намальоване на стан гри.

      Різниця тільки для рядів вище межі прунингу: get() згенерував би
      такий ряд наново (цілим!) і поклав у кеш — і кірка, яка колись
      туди повернеться, зіткнулась би з блоками, яких на сервері вже
      немає. Тобто клієнт розійшовся б із сервером через саме лише
      малювання. Тут такий ряд рахується транзитно і в кеш не лягає.
      Ряди нижче межі кешуються як звичайно — фізика все одно попросить
      їх наступними кроками, і згенеровані вони будуть ідентично. */
  peek(r: number, c: number): Cell | null | WallCell {
    if (c < 0 || c >= this.cols) return WALL;
    if (r < 0) return null;
    const cached = this.rows.get(r);
    if (cached) return cached[c];
    if (r < this.prunedAbove) return this.genRow(r)[c];
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
    if (aboveRow > this.prunedAbove) this.prunedAbove = aboveRow;
  }
}

export const isWall = (v: Cell | null | WallCell): v is WallCell => v === WALL;
export const blockOf = (cell: Cell) => BLOCKS[cell.id];
