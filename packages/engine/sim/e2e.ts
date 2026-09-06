/* ============================================================
   E2E — перевірка живого API тим самим рушієм, що й у клієнта.

   Робимо рівно те, що робить браузер: створюємо сесію, граємо
   раунди, і КОЖЕН перераховуємо локально з присланого сида.
   Плюс перевіряємо, що сервер веде гаманець сам:
     - баланс сходиться як (було - ставка + виплата);
     - ставку поза списком не приймають;
     - ідемпотентний ключ не списує ставку вдруге.

   Авторизація тут dev-режимна (x-dev-user) — сервер приймає її
   тільки коли не заданий TELEGRAM_BOT_TOKEN і це не продакшн.

   Сервер має бути піднятий: npm run start -w @minedrop/api
   npm run sim:e2e -- [раундів] [URL]
   ============================================================ */

import { CONFIG, buildSetup, resolveRound, roundSeed, verifyCommit } from '../src';
import type { RoundMode, RoundResult } from '../src';

const N = parseInt(process.argv[2] || '60', 10);
const BASE = process.argv[3] || 'http://localhost:4000/api';

let bad = 0;
const fail = (m: string) => { console.log('FAIL:', m); bad++; };

interface PlayerState {
  telegramId: number; balance: number;
  clientSeed: string; serverSeedHash: string; nonce: number;
}

/* Різний гравець на кожен прогін — щоб тест не залежав від
   попереднього стану сервера. */
const DEV_USER = String(900000 + Math.floor(Math.random() * 90000));

async function call<T>(path: string, init?: RequestInit & { idempotencyKey?: string }): Promise<T> {
  const res = await fetch(BASE + path, {
    method: init?.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-dev-user': DEV_USER,
      ...(init?.idempotencyKey ? { 'x-idempotency-key': init.idempotencyKey } : {}),
    },
    body: init?.body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

async function main() {
  const me = await call<PlayerState>('/players/me');
  console.log('гравець:', me.telegramId, '| баланс:', me.balance,
              '| хеш сида:', me.serverSeedHash.slice(0, 16) + '…');

  let balance = me.balance;
  let expectedNonce = 0;
  let played = 0, wins = 0;

  for (let i = 0; i < N; i++) {
    const mode: RoundMode = 'bet';
    const bet = CONFIG.bets[i % CONFIG.bets.length];
    if (balance < bet) { console.log('монети скінчились на раунді', i); break; }

    const { round, player } = await call<{ round: RoundResult; player: PlayerState }>(
      '/rounds/play', { method: 'POST', body: JSON.stringify({ bet, mode }) });
    played++;
    if (round.payout > round.cost) wins++;

    /* 1. Раунд відтворюється з сида — те саме, що робить клієнт */
    const local = resolveRound(round.seed, round.mode, round.bet, round.pity);
    if (local.payout !== round.payout) {
      fail(`виплата не відтворилась (nonce ${round.fair.nonce}): локально ${local.payout}, сервер ${round.payout}`);
    }
    if (local.setup.spins.join() !== round.spins.join()) {
      fail(`прокрути не відтворились (nonce ${round.fair.nonce})`);
    }
    if (local.setup.startCols.join() !== round.startCols.join()) {
      fail(`колонки не відтворились (nonce ${round.fair.nonce})`);
    }
    if (buildSetup(round.seed, round.pity).tiers.join() !== round.tiers.join()) {
      fail(`кірки не відтворились (nonce ${round.fair.nonce})`);
    }

    /* 2. Гаманець веде сервер, і веде правильно */
    if (round.balanceBefore !== balance) {
      fail(`баланс на вході розійшовся: у нас ${balance}, сервер ${round.balanceBefore}`);
    }
    const expected = round.balanceBefore - round.cost + round.payout;
    if (round.balanceAfter !== expected) {
      fail(`баланс на виході: ${round.balanceAfter}, мало бути ${expected}`);
    }
    if (player.balance !== round.balanceAfter) fail('баланс у стані гравця не збігся з раундом');
    balance = round.balanceAfter;

    /* 3. Ціна раунду = ставка */
    if (round.cost !== bet) fail(`ціна раунду ${round.cost}, мало бути ${bet}`);

    /* 4. nonce росте рівно на 1 */
    expectedNonce++;
    if (round.fair.nonce !== expectedNonce) {
      fail(`nonce ${round.fair.nonce}, мало бути ${expectedNonce}`);
    }
    if (roundSeed('00'.repeat(32), round.fair.clientSeed, round.fair.nonce) === round.seed) {
      fail('сид не залежить від серверного секрету');
    }
  }

  /* 5. Ставку поза списком не приймають */
  try {
    await call('/rounds/play', { method: 'POST', body: JSON.stringify({ bet: 37, mode: 'bet' }) });
    fail('сервер прийняв ставку поза списком');
  } catch { /* очікувано */ }

  /* 8. Ідемпотентність: той самий ключ не списує ставку вдруге */
  const stateBefore = await call<PlayerState>('/players/me');
  if (stateBefore.balance >= 10) {
    const key = 'idem-test-' + Date.now();
    const first = await call<{ round: RoundResult; player: PlayerState }>(
      '/rounds/play', { method: 'POST', idempotencyKey: key, body: JSON.stringify({ bet: 10, mode: 'bet' }) });
    const again = await call<{ round: RoundResult; player: PlayerState }>(
      '/rounds/play', { method: 'POST', idempotencyKey: key, body: JSON.stringify({ bet: 10, mode: 'bet' }) });

    if (first.round.roundId !== again.round.roundId) fail('ретрай із тим самим ключем зіграв НОВИЙ раунд');
    if (again.player.balance !== first.player.balance) fail('ретрай із тим самим ключем змінив баланс');
    expectedNonce++;

    const other = await call<{ round: RoundResult }>(
      '/rounds/play', { method: 'POST', idempotencyKey: key + '-x', body: JSON.stringify({ bet: 10, mode: 'bet' }) });
    if (other.round.roundId === first.round.roundId) fail('інший ключ повернув старий раунд');
    expectedNonce++;
  }

  /* 9. Розкриття сида і перевірка минулого раунду */
  const rot = await call<{ revealed: { serverSeed: string; serverSeedHash: string; clientSeed: string; rounds: number } }>(
    '/fairness/rotate', { method: 'POST' });
  if (!verifyCommit(rot.revealed.serverSeed, rot.revealed.serverSeedHash)) {
    fail('розкритий serverSeed не відповідає опублікованому хешу');
  }
  if (rot.revealed.rounds !== expectedNonce) fail('кількість раундів у серії не збіглась');

  console.log('\nраундів:', played, '| виграшних:', wins, '| баланс:', balance);
  console.log('розкритий serverSeed:', rot.revealed.serverSeed.slice(0, 24) + '…',
              '-> хеш зійшовся');
  console.log(bad === 0 ? 'E2E OK — сервер рахує, клієнт відтворює, гаманець сходиться' : bad + ' failures');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('E2E впав:', e.message); process.exit(1); });
