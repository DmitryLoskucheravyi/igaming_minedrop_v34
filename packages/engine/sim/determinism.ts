/* ============================================================
   ДЕТЕРМІНІЗМ — головний тест архітектури.

   Уся конструкція «сервер вирішує, клієнт малює» тримається на
   одному: з одного сида має вийти один і той самий раунд. Якщо це
   не так — клієнт покаже одну виплату, сервер нарахує іншу, і гра
   виглядатиме як обман, навіть коли сервер чесний.

   Перевіряємо три речі, і третя — найважливіша:
     1. Той самий сид двічі -> байт у байт те саме.
     2. Різні сиди -> різні раунди (тобто ми не зафіксували константу).
     3. «Клієнтський» прогін -> те саме, що серверний.
        Клієнт малює ряди НАПЕРЕД і крокує фізику дрібними порціями,
        як приходять кадри. Саме тут ламається наївна реалізація:
        якби шахта сіялась спільним послідовним потоком, зайвий
        mine.row() на рендері зсунув би всю генерацію.

   npm run sim:determinism -- [раундів]
   ============================================================ */

import { CONFIG } from '../src/config';
import { buildSetup, createRun, resolveRound } from '../src/round';
import type { RoundMode } from '../src/types';
import { seedAt } from './seeds';

const N = parseInt(process.argv[2] || '400', 10);

let bad = 0;
const fail = (m: string) => { console.log('FAIL:', m); bad++; };

/* Серверний прогін: просто до кінця. */
function server(seed: string, mode: RoundMode, bet: number) {
  const r = resolveRound(seed, mode, bet);
  return { payout: r.payout, collected: r.sim.collected, steps: r.sim.steps,
           blocks: r.sim.blocks, depth: r.sim.depth, chain: r.sim.multChain,
           spins: r.setup.spins.join(','), cols: r.setup.startCols.join(',') };
}

/* Клієнтський прогін: рендер чіпає ряди наперед, кроки йдуть пачками
   різного розміру (нерівний фреймрейт), між ними — prune старих рядів. */
function client(seed: string, mode: RoundMode, bet: number) {
  const setup = buildSetup(seed, mode);
  const made = createRun(seed, setup);
  if (!made) {
    return { payout: 0, collected: 0, steps: 0, blocks: 0, depth: 0, chain: 1,
             spins: setup.spins.join(','), cols: setup.startCols.join(',') };
  }
  const { mine, run } = made;

  let guard = 0;
  let frame = 0;
  while (!run.over && guard < CONFIG.phys.maxSteps) {
    // рендер: дивимось на 14 рядів уперед від найглибшої кірки
    const lead = Math.max(0, Math.floor(run.depth));
    for (let r = Math.max(0, lead - 3); r < lead + 14; r++) {
      for (let c = 0; c < CONFIG.cols; c++) mine.get(r, c);
    }
    // кадр: від 1 до 9 кроків фізики, як набігло реального часу
    const steps = 1 + (frame++ % 9);
    for (let s = 0; s < steps && !run.over; s++) { run.events.length = 0; run.tick(); guard++; }
    // прибирати шахту вручну не можна — це робить сам Run
  }

  if (mine.rows.size > 4000) fail(`шахта не прибирається: ${mine.rows.size} рядів`);

  const raw = Math.round(run.collected * bet / CONFIG.payoutK);
  return {
    payout: Math.min(raw, bet * CONFIG.maxWinX),
    collected: run.collected, steps: run.steps, blocks: run.blocks,
    depth: run.depth, chain: run.multChain,
    spins: setup.spins.join(','), cols: setup.startCols.join(','),
  };
}

const j = (o: unknown) => JSON.stringify(o);

/* Перевірка «різні сиди -> різні раунди» рахується ТІЛЬКИ по раундах
   із кіркою. «Пусто» — легітимний і, при spinsPerBet=1, ГОЛОВНИЙ
   результат: рівно один прокрут або влучив, або ні, фізики немає
   зовсім, тому всі промахи дають один і той самий тривіальний
   об'єкт {payout:0, steps:0, ...} байт у байт — це не збіг сида,
   а те, що порожній раунд просто нема з чого відрізнити. Якби ми
   вимагали різноманітності і від них, тест ловив би не баг
   детермінізму, а власну неправильну очікувану поведінку. */
let distinctAll = new Set<string>();
let distinctPlayed = new Set<string>();
let played = 0;

for (let i = 0; i < N; i++) {
  const seed = seedAt(i);
  const mode = 'bet' as RoundMode;
  const bet = CONFIG.bets[i % CONFIG.bets.length];

  const a = server(seed, mode, bet);
  const b = server(seed, mode, bet);
  const c = client(seed, mode, bet);

  if (j(a) !== j(b)) fail(`сервер нестабільний на сиді ${seed.slice(0, 12)}\n  ${j(a)}\n  ${j(b)}`);
  if (j(a) !== j(c)) fail(`клієнт розійшовся з сервером на сиді ${seed.slice(0, 12)}\n  сервер ${j(a)}\n  клієнт ${j(c)}`);

  distinctAll.add(j(a));
  if (a.steps > 0) { played++; distinctPlayed.add(j(a)); }
}

if (played < N * 0.05) {
  fail(`лише ${played} із ${N} раундів узагалі щось зіграли — перевір ваги рулетки`);
} else if (distinctPlayed.size < played * 0.95) {
  fail(`серед ${played} зіграних раундів лише ${distinctPlayed.size} унікальних — схоже, сид не впливає на фізику`);
}

console.log('раундів:', N, '| із кіркою:', played);
console.log('унікальних результатів серед зіграних:', distinctPlayed.size, '/', played,
            '| разом із порожніми (не мусять бути унікальними):', distinctAll.size, '/', N);
console.log(bad === 0 ? 'DETERMINISM OK — клієнт і сервер сходяться' : bad + ' failures');
process.exit(bad ? 1 : 0);
