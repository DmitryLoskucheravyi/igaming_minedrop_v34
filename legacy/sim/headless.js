/* Ганяє РЕАЛЬНІ браузерні файли гри у фейковому DOM: рулетку, стани,
   бонуску за стрік, куплену бонуску, фізику, камеру, виплати.
   node sim/headless.js [ставок] */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BETS = parseInt(process.argv[2] || '150', 10);
const DT = 1 / 60;

/* ---- фейковий canvas ctx: усі методи — пустишки ---- */
const grad = { addColorStop() {} };
const ctxStub = new Proxy({}, {
  get(t, k) {
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
    if (k === 'measureText') return () => ({ width: 10 });
    if (k in t) return t[k];
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; }
});

function el(id) {
  return {
    id, textContent: '', disabled: false, className: '', offsetHeight: 76,
    children: [], style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild(c) { this.children.push(c); },
    addEventListener() {}, remove() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 700 }),
    getContext: () => ctxStub
  };
}

const els = {};
global.self = global;
global.window = global;
global.innerWidth = 1280;
global.innerHeight = 800;
global.devicePixelRatio = 1;
global.addEventListener = () => {};
global.document = {
  getElementById: id => (els[id] = els[id] || el(id)),
  querySelector: sel => (els[sel] = els[sel] || el(sel)),
  createElement: () => el('btn'),
  querySelectorAll: () => [],
  addEventListener: () => {}
};
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => 0;      // цикл крутимо вручну
global.Image = class { set src(v) { setTimeout(() => this.onerror && this.onerror(), 0); } };

for (const f of ['config.js', 'assets.js', 'world.js', 'run.js', 'render.js', 'reel.js', 'game.js'])
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), { filename: f });

const ev = e => vm.runInThisContext(e);
const g = ev('Game'), CFG = ev('CONFIG');
const B = CFG.bonus;

g.init();

let fails = 0;
const t = (c, m) => { if (!c) { console.log('FAIL:', m); fails++; } };

t(g.state === 'IDLE', 'не IDLE після init');
t(g.balance === CFG.startBalance, 'невірний стартовий баланс');
t(g.cell > 0 && g.itemH > 0, 'розкладка не порахувалась');
t(Math.abs(g.itemW / g.itemH - CFG.reel.widthRatio) < 0.01, 'комірка рулетки не втричі ширша');

/* крутити гру, поки не справдиться умова */
function runUntil(pred, limit) {
  let guard = 0;
  const seen = new Set();
  while (!pred() && guard++ < (limit || 400000)) { g.update(DT); g.draw(); seen.add(g.state); }
  return { ok: pred(), seen };
}

const tiers = {};
let totalBet = 0, totalWin = 0, drops = 0, nones = 0, dryBets = 0, maxX = 0;
let streakBonuses = 0, capHits = 0;

for (let n = 0; n < BETS; n++) {
  if (g.balance < g.bet) g.balance += 100000;    // докидаємо, щоб не впертись у нуль
  const before = g.balance;
  const streakBefore = g.streak;

  g.startBet();
  t(g.balance === before - g.bet, 'ставка не списалась');
  t(g.state === 'SPIN', 'перший прокрут не стартував');
  t(!g.inBonus, 'звичайна ставка позначена як бонусна');
  totalBet += g.bet;

  const r = runUntil(() => g.state === 'RESULT');
  t(r.ok, 'ставка не дограла, застрягла в ' + g.state);

  const picks = g.results.filter(x => !x.none).length;
  t(g.results.length <= CFG.spinsPerBet, 'спроб більше за ' + CFG.spinsPerBet);
  t(picks <= 1, 'за ставку випало більше однієї кірки: ' + picks);
  if (picks === 1) {
    t(!g.results[g.results.length - 1].none, 'кірка не остання — прокрути не зупинились');
    t(r.seen.has('RISE'), 'не було переходу RISE');
    t(g.run && g.run.picks.length === 1, 'у звичайній грі має бути рівно одна кірка');
  } else {
    dryBets++;
    t(g.results.length === CFG.spinsPerBet, 'без кірки мало бути рівно 7 спроб');
    t(g.betWin === 0, 'виграш без жодної кірки');
  }

  // стрік порахований правильно, і бонуска НЕ перервала ставку
  const expected = picks ? streakBefore + 1 : 0;
  if (expected >= B.streak) t(g.bonusPending && g.streak === 0, 'стрік добіг, але бонуска не запланована');
  else t(!g.bonusPending && g.streak === expected, 'стрік порахований невірно');

  for (const x of g.results) { if (x.none) nones++; else { drops++; tiers[x.id] = (tiers[x.id] || 0) + 1; } }
  t(g.balance === before - g.bet + g.betWin, 'баланс не збігається з виграшем');
  totalWin += g.betWin;
  maxX = Math.max(maxX, g.betWin / g.bet);
  if (g.betWin >= g.bet * CFG.maxWinX) capHits++;

  const hadPending = g.bonusPending;
  g.resultT = 1;
  g.endBet();

  if (hadPending) {                              // бонуска за стрік стартує ПІСЛЯ ставки
    streakBonuses++;
    t(g.inBonus, 'бонуска не стартувала після стріку');
    t(g.state === 'BSPIN', 'бонуска не почала крутити, state=' + g.state);
    const rb = runUntil(() => g.state === 'RESULT');
    t(rb.ok, 'бонуска не дограла, застрягла в ' + g.state);
    t(g.results.length === B.spins, 'у бонусці не ' + B.spins + ' прокрутів, а ' + g.results.length);
    t(g.bonusTiers.length >= B.guarantee, 'бонуска без гарантованої кірки');
    t(g.run.picks.length === g.bonusTiers.length, 'у шахту впало не стільки кірок, скільки випало');
    t(g.mine.bonus, 'бонуска грається у звичайній шахті без множників');
    totalWin += g.betWin;
    g.resultT = 1;
    g.endBet();
  }
  t(g.state === 'IDLE', 'endBet не спрацював, state=' + g.state);
  t(!g.inBonus, 'inBonus не скинувся');
  t(g.mine.rows.size < 60, 'шахта не скинулась: ' + g.mine.rows.size);
}

/* ---- форсуємо стрік, щоб точно перевірити цей шлях ---- */
let forced = 0;
for (let i = 0; i < 40 && forced < 3; i++) {
  g.balance = 1e7;
  g.streak = B.streak - 1;                       // лишилась одна ставка до бонуски
  g.startBet();
  const r = runUntil(() => g.state === 'RESULT');
  t(r.ok, 'форсована ставка не дограла');
  const picks = g.results.filter(x => !x.none).length;
  if (!picks) { g.resultT = 1; g.endBet(); continue; }

  t(g.bonusPending, 'стрік добіг, але бонуска не запланована');
  t(g.state === 'RESULT', 'бонуска перервала поточну ставку');   // головне: НЕ перериває
  const winBefore = g.betWin;
  t(winBefore === g.run.payout(g.bet), 'виграш ставки загубився перед бонускою');

  g.resultT = 1; g.endBet();
  t(g.inBonus && g.state === 'BSPIN', 'бонуска не стартувала після ставки');
  const rb = runUntil(() => g.state === 'RESULT');
  t(rb.ok, 'форсована бонуска не дограла, застрягла в ' + g.state);
  t(g.results.length === B.spins, 'у бонусці не ' + B.spins + ' прокрутів');
  t(g.run.picks.length >= B.guarantee, 'у бонусці менше кірок за гарантію');
  t(g.run.mine.bonus, 'бонусна шахта без множників');
  t(g.streak === 0, 'стрік не обнулився після бонуски');
  forced++;
  g.resultT = 1; g.endBet();
}

/* ---- окремо перевіряємо КУПІВЛЮ бонуски ---- */
let bought = 0, boughtWin = 0, boughtSpend = 0;
for (let i = 0; i < 12; i++) {
  g.balance = 1e7;
  const cost = g.bet * B.buyCost;
  const before = g.balance;
  g.buyBonus();
  t(g.balance === before - cost, 'ціна бонуски списалась невірно');
  t(g.inBonus && g.bonusBought, 'куплена бонуска не позначена');
  const r = runUntil(() => g.state === 'RESULT');
  t(r.ok, 'куплена бонуска не дограла, застрягла в ' + g.state);
  t(g.results.length === B.spins, 'у купленій бонусці не ' + B.spins + ' прокрутів');
  t(g.betWin <= g.bet * CFG.maxWinX, 'виграш пробив стелю maxWinX');
  boughtWin += g.betWin; boughtSpend += cost; bought++;
  g.resultT = 1; g.endBet();
}

const spins = nones + drops;
console.log('\nставок:', BETS, '| прокрутів:', spins, '| кірка в',
            ((drops / spins) * 100).toFixed(1) + '% прокрутів');
console.log('ставок без кірки:', ((dryBets / BETS) * 100).toFixed(1) + '%',
            '| бонусок за стрік:', streakBonuses, '| стеля виграшу спрацювала:', capHits);
console.log('випадання кірок:', tiers);
console.log('RTP звичайної гри + стрік:', ((totalWin / totalBet) * 100).toFixed(1) + '%',
            '| макс x' + maxX.toFixed(1));
console.log('форсованих бонусок за стрік:', forced);
console.log('куплених бонусок:', bought, '| віддали', ((boughtWin / boughtSpend) * 100).toFixed(0) + '% ціни');
console.log(fails === 0 ? '\nHEADLESS OK — гра відпрацювала без помилок' : '\n' + fails + ' failures');
process.exit(fails ? 1 : 0);
