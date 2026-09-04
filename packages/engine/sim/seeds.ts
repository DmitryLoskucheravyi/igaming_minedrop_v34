/* Сиди для симуляцій. Відтворювані: node sim/x.ts дає ті самі числа,
   поки не змінили BASE. Хочеш іншу вибірку — постав інший BASE. */
import { sha256, toHex, utf8 } from '../src/rng';

export const BASE = process.env.SIM_BASE || 'minedrop-sim-v1';

export const seedAt = (i: number) => toHex(sha256(utf8(`${BASE}:${i}`)));
