/* ============================================================
   ЦІНИ БОНУС БАЮ.

   Купівля має бути іншим ТЕМПОМ гри, а не вигіднішою ставкою: віддача
   бонуски мусить збігатися зі звичайною грою. Тому міряємо середню
   виплату гарантованого забігу кожною кіркою в БОНУСНІЙ шахті й
   рахуємо ціну як EV / базовий RTP.

   npm run sim:buy -- [забігів на кірку]
   ============================================================ */
import { CONFIG, TIERS } from '../src/config';
import { resolveRound, roundCost } from '../src/round';
import { roundSeed } from '../src/fairness';
import type { TierId } from '../src/types';

const N = parseInt(process.argv[2] || '20000', 10);
const BET = 1;

/* Базовий RTP звичайної гри — з ним і треба зрівняти бонуску. */
function baseRtp(n: number): number {
  let sum = 0, dry = 0;
  for (let i = 0; i < n; i++) {
    const seed = roundSeed('base', 'c', i + 1);
    const pity = dry >= CONFIG.pity;
    const r = resolveRound(seed, 'bet', BET, pity);
    dry = r.setup.tiers.length ? 0 : dry + 1;
    sum += r.payout;
  }
  return sum / n / BET;
}

const rtp = baseRtp(N);
console.log(`базовий RTP звичайної гри: ${(rtp * 100).toFixed(2)}%  (${N} ставок)\n`);
console.log('кірка      HP  урон   середня виплата   ціна для того ж RTP   зараз у конфізі');

for (const t of TIERS) {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const seed = roundSeed('buy-' + t.id, 'c', i + 1);
    const r = resolveRound(seed, 'buy', BET, false, t.id as TierId);
    sum += r.payout;
  }
  const ev = sum / N / BET;              // у ставках
  const fair = ev / rtp;                 // ціна, за якої RTP бонуски = базовому
  // саме множник із конфігу, а не roundCost при ставці 1 (там округлення)
  const now = CONFIG.buy.price[t.id];
  void roundCost;
  console.log(
    t.name.padEnd(9),
    String(t.hp).padStart(4),
    String(t.dmg).padStart(5),
    ('x' + ev.toFixed(2)).padStart(18),
    ('x' + fair.toFixed(1)).padStart(22),
    ('x' + now).padStart(17),
  );
}
