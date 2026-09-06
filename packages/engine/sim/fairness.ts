/* ============================================================
   FAIRNESS — перевірка commit-reveal наскрізь.

   Симулюємо те, що робить гравець: бере опублікований хеш,
   свій clientSeed, розкритий serverSeed — і сам перераховує раунд.
   Якщо цей файл проходить, кнопка «перевірити» в UI не бутафорія.

   npm run sim:fair -- [раундів]
   ============================================================ */

import { resolveRound, roundCost } from '../src/round';
import { roundSeed, serverSeedHash, verifyCommit } from '../src/fairness';
import { sha256, toHex, utf8 } from '../src/rng';
import type { RoundMode } from '../src/types';

const N = parseInt(process.argv[2] || '500', 10);

let bad = 0;
const fail = (m: string) => { console.log('FAIL:', m); bad++; };

/* Сервер: придумав сид, опублікував хеш */
const serverSeed = toHex(sha256(utf8('demo-server-seed')));
const published = serverSeedHash(serverSeed);
const clientSeed = 'гравець-написав-своє';

if (!verifyCommit(serverSeed, published)) fail('хеш не сходиться зі своїм же сидом');
if (verifyCommit(toHex(sha256(utf8('інший'))), published)) fail('чужий сид пройшов перевірку');

const seen = new Set<string>();

for (let nonce = 1; nonce <= N; nonce++) {
  const mode = 'bet' as RoundMode;
  const bet = 50;

  // сервер грає раунд
  const seed = roundSeed(serverSeed, clientSeed, nonce);
  const played = resolveRound(seed, mode, bet);

  // гравець після розкриття рахує те саме сам
  const reseed = roundSeed(serverSeed, clientSeed, nonce);
  const check = resolveRound(reseed, mode, bet);

  if (seed !== reseed) fail(`сид не відтворився на nonce ${nonce}`);
  if (played.payout !== check.payout) fail(`виплата не відтворилась на nonce ${nonce}`);
  if (played.setup.spins.join() !== check.setup.spins.join()) fail(`рулетка не відтворилась на nonce ${nonce}`);

  // сусідній nonce мусить давати інший сид
  const next = roundSeed(serverSeed, clientSeed, nonce + 1);
  if (next === seed) fail(`nonce ${nonce} і ${nonce + 1} дали однаковий сид`);
  // і інший clientSeed теж
  if (roundSeed(serverSeed, clientSeed + 'x', nonce) === seed) fail(`clientSeed не впливає на сид`);

  seen.add(seed);
  void roundCost(mode, bet);
}

if (seen.size !== N) fail(`сиди повторюються: ${seen.size} унікальних із ${N}`);

/* ---- PITY ----
   Кожна CONFIG.pity-та порожня ставка поспіль форсує кірку: з таблиці
   прокруту прибирається «пусто». Це ЧАСТИНА раунду, тому перевірка
   мусить знати той самий прапорець, інакше вона рахує інший раунд.

   Саме цього тут раніше не було: /fairness/verify і панель у клієнті
   кликали resolveRound() без pity, і кожен восьмий раунд «не сходився»,
   хоча сервер грав чесно. Симуляція проходила, бо теж дивилась лише на
   pity=false. Тепер перевіряємо обидві гілки — і те, що вони РІЗНІ. */
let pityDiff = 0;
for (let nonce = 1; nonce <= 200; nonce++) {
  const bet = 50;
  const seed = roundSeed(serverSeed, clientSeed, nonce);

  const forced = resolveRound(seed, 'bet' as RoundMode, bet, true);
  const recheck = resolveRound(seed, 'bet' as RoundMode, bet, true);
  if (forced.payout !== recheck.payout) fail(`pity-раунд не відтворився на nonce ${nonce}`);
  if (!forced.setup.tiers.length) fail(`pity не гарантував кірку на nonce ${nonce}`);
  if (!forced.setup.pity) fail(`прапорець pity загубився на nonce ${nonce}`);

  // перевірка без прапорця мусить давати ІНШЕ — інакше він нічого не значить
  const naive = resolveRound(seed, 'bet' as RoundMode, bet, false);
  if (naive.payout !== forced.payout || naive.setup.tiers.join() !== forced.setup.tiers.join()) {
    pityDiff++;
  }
}
if (pityDiff === 0) fail('pity ні на що не впливає — перевірка нічого не ловить');
console.log(`pity: перевірено 200 раундів, від звичайних відрізняються ${pityDiff}`);


console.log('раундів перевірено:', N);
console.log('serverSeedHash:', published.slice(0, 24) + '…');
console.log(bad === 0 ? 'FAIRNESS OK — раунд відтворюється з розкритого сида' : bad + ' failures');
process.exit(bad ? 1 : 0);
