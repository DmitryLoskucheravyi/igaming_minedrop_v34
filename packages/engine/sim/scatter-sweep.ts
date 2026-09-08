/* ============================================================
   РОЗГОРТКА ВАГИ СКАТТЕРА.

   Питання, на яке відповідає цей замір: яку частку RTP віддати
   безкоштовній бонусці. Це не «наскільки часто падає блок» — одне
   спрацювання коштує близько сорока звичайних ставок, тому вага
   вирішує розподіл грошей між базовою грою і бонускою, а не темп
   подій на екрані.

   Для кожної ваги рахуємо ПОСЛІДОВНИЙ потік ставок (виграна бонуска
   грається наступним раундом безкоштовно, ретригер працює) і зводимо:
     - як часто спрацьовує;
     - яка частка всієї виплати приходить із безкоштовних раундів;
     - який payoutK поверне сумарний RTP на 88%;
     - яким при цьому лишиться RTP базової гри.

   Остання колонка й вирішує: увесь сенс правки в тому, скільки
   забирається у звичайного прокруту заради бонуски.

   npm run sim:scatter:sweep -- [ставок]
   ============================================================ */

import { CONFIG } from '../src/config';
import { resolveRound } from '../src/round';
import { roundSeed } from '../src/fairness';

const N = parseInt(process.argv[2] || '120000', 10);
const TARGET = 0.88;
const WEIGHTS = [0, 0.06, 0.1, 0.14, 0.18, 0.25, 0.35, 0.5];

/* CONFIG оголошений `as const`, а тут вага навмисно міняється в циклі —
   це замір, а не гра. */
const sc = CONFIG.scatter as { weight: number; need: number; fromRow: number };
const before = sc.weight;

interface Row {
  w: number; trig: number; retrig: number;
  share: number; kFit: number; baseAtFit: number;
}

const rows: Row[] = [];

for (const w of WEIGHTS) {
  sc.weight = w;

  let staked = 0, paid = 0, paidFree = 0;
  let dry = 0, bets = 0, freeRounds = 0, triggers = 0, retriggers = 0;
  let pending = 0, nonce = 0;

  for (let i = 0; i < N; i++) {
    while (pending > 0) {
      pending--;
      freeRounds++;
      const r = resolveRound(roundSeed('srv-sw', 'cli', ++nonce), 'bet', 1, false, undefined, true);
      const win = Math.min(r.sim.collected / CONFIG.payoutK, CONFIG.maxWinX);
      paid += win; paidFree += win;
      if (r.bonusWon) { pending++; retriggers++; }
    }

    const pity = dry >= CONFIG.pity;
    const r = resolveRound(roundSeed('srv-sw', 'cli', ++nonce), 'bet', 1, pity);
    bets++; staked += 1;
    paid += Math.min(r.sim.collected / CONFIG.payoutK, CONFIG.maxWinX);
    dry = r.setup.tiers.length ? 0 : dry + 1;
    if (r.bonusWon) { pending++; triggers++; }
  }

  const rtpTotal = paid / staked;
  /* payoutK ділить УСІ виплати однаково, тож повернути сумарний RTP на
     ціль — це просто масштаб. Частка бонуски від цього не змінюється. */
  const kFit = CONFIG.payoutK * rtpTotal / TARGET;
  const share = paidFree / paid;

  rows.push({
    w,
    trig: triggers / bets,
    retrig: freeRounds ? retriggers / freeRounds : 0,
    share,
    kFit,
    baseAtFit: TARGET * (1 - share),
  });
}

sc.weight = before;

const pct = (x: number, d = 2) => (x * 100).toFixed(d) + '%';
const one = (x: number) => (x > 0 ? '1/' + Math.round(1 / x) : '—');

console.log(`\nВАГА СКАТТЕРА  (${N.toLocaleString('uk')} ставок на точку, need ${sc.need}, ціль RTP ${pct(TARGET, 0)})\n`);
console.log('   вага   спрацювань    ретригер   частка RTP   payoutK   базова гра');
console.log('  ' + '-'.repeat(70));
for (const r of rows) {
  console.log(
    '  ' + r.w.toFixed(2).padStart(5) +
    '   ' + (pct(r.trig) + ' ' + one(r.trig)).padStart(15) +
    '   ' + pct(r.retrig, 1).padStart(7) +
    '   ' + pct(r.share, 1).padStart(9) +
    '   ' + Math.round(r.kFit).toString().padStart(7) +
    '   ' + pct(r.baseAtFit, 1).padStart(9),
  );
}
console.log(`\n  зараз у конфізі: вага ${before}, payoutK ${CONFIG.payoutK}\n`);
