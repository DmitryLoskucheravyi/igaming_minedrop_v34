/* ============================================================
   СКАТТЕРИ: як часто випадає безкоштовна бонуска і що вона робить із RTP.

   Рахуємо не «шанс на блок», а те, що справді відчуває гравець:
   ПОСЛІДОВНИЙ потік ставок, у якому виграна бонуска грається наступним
   раундом безкоштовно, а скаттери в самій бонусці дають ретригер.

   RTP тут = (усе виплачене) / (усе внесене). Безкоштовний раунд додає
   виплату й НЕ додає внеску — саме тому фіча піднімає RTP, і саме тому
   її треба міряти, а не прикидати.

   npm run sim:scatter -- [ставок]
   ============================================================ */

import { CONFIG } from '../src/config';
import { resolveRound } from '../src/round';
import { roundSeed } from '../src/fairness';

const N = parseInt(process.argv[2] || '300000', 10);
const BET = 1;

let staked = 0;          // скільки гравець вніс (безкоштовні раунди не рахуються)
let paid = 0;            // скільки виплачено всього
let paidFree = 0;        // з них — у безкоштовних раундах
let dry = 0;

let bets = 0;            // платних ставок
let freeRounds = 0;      // зіграно безкоштовних бонусок
let triggers = 0;        // спрацювань зі звичайної ставки
let retriggers = 0;      // спрацювань усередині бонуски
let runsNormal = 0;      // забігів у звичайній грі (кірка випала)
let scatterHist = new Map<number, number>();

/* Черга виграних бонусок. У житті вона завжди довжиною 0 або 1, але
   ретригер під час бонуски додає ще одну — тримаємо явно, щоб не
   загубити жодної. */
let pending = 0;
let nonce = 0;

for (let i = 0; i < N; i++) {
  /* Спершу відіграємо все, що виграно раніше: у грі наступна ставка
     гравця перетворюється на бонуску, а не йде поруч із нею. */
  while (pending > 0) {
    pending--;
    freeRounds++;
    const r = resolveRound(roundSeed('srv-sc', 'cli', ++nonce), 'bet', BET, false, undefined, true);
    const win = Math.min(r.sim.collected / CONFIG.payoutK, CONFIG.maxWinX) * BET;
    paid += win;
    paidFree += win;
    if (r.bonusWon) { pending++; retriggers++; }
  }

  const pity = dry >= CONFIG.pity;
  const r = resolveRound(roundSeed('srv-sc', 'cli', ++nonce), 'bet', BET, pity);
  bets++;
  staked += BET;
  paid += Math.min(r.sim.collected / CONFIG.payoutK, CONFIG.maxWinX) * BET;

  const gotPick = r.setup.tiers.length > 0;
  dry = gotPick ? 0 : dry + 1;

  if (gotPick) {
    runsNormal++;
    const n = Math.min(r.sim.scatters, 6);
    scatterHist.set(n, (scatterHist.get(n) ?? 0) + 1);
  }
  if (r.bonusWon) { pending++; triggers++; }
}

const pct = (x: number) => (x * 100).toFixed(2) + '%';
const one = (x: number) => (x > 0 ? '1 / ' + Math.round(1 / x) : '—');

console.log(`\nСКАТТЕРИ  (${N.toLocaleString('uk')} платних ставок, вага ${CONFIG.depthWeights?.toString ? '' : ''}scatter, need ${CONFIG.scatter.need})\n`);

console.log('  скаттерів за забіг у звичайній грі:');
for (const k of [...scatterHist.keys()].sort((a, b) => a - b)) {
  const v = scatterHist.get(k)!;
  console.log(`    ${k}${k === 6 ? '+' : ' '} : ${pct(v / runsNormal).padStart(7)}  (${v})`);
}

console.log('');
console.log(`  забігів у звичайній грі : ${pct(runsNormal / bets)} ставок`);
console.log(`  бонуска зі ставки       : ${pct(triggers / bets)}  ${one(triggers / bets)} ставок`);
console.log(`  ретригер у бонусці      : ${pct(retriggers / Math.max(1, freeRounds))}`);
console.log(`  безкоштовних раундів    : ${freeRounds.toLocaleString('uk')}`);

const rtpTotal = paid / staked;
const rtpBase = (paid - paidFree) / staked;

console.log('');
console.log(`  RTP без скаттерів : ${pct(rtpBase)}`);
console.log(`  RTP зі скаттерами : ${pct(rtpTotal)}   (+${pct(rtpTotal - rtpBase)})`);
console.log('');
console.log(`  payoutK зараз ${CONFIG.payoutK}`);
console.log(`  щоб лишити 88%: payoutK = ${Math.round(CONFIG.payoutK * rtpTotal / 0.88)}`);
console.log('');
