/* ============================================================
   Реферальна нагорода: коіни за прихід друга.

   Перевіряємо саме те, де ціна помилки — коіни: чи не платиться те
   саме двічі й чи не нараховується виплата, коли запрошувача вже немає.
   ============================================================ */

import assert from 'node:assert/strict';
import { ReferralsService, REF_JOIN_COINS } from '../src/referrals/referrals.service';
import type { PlayerRecord } from '../src/players/players.service';

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}

/* Стенд повторює рівно те, чим користується сервіс: пошук гравця,
   нарахування й збереження. Створення запису (і саму прив'язку refBy)
   робить PlayersService, тому тут воно імітується прямо. */
function make() {
  const db = new Map<number, PlayerRecord>();
  let hook: ((rec: PlayerRecord) => void) | null = null;

  const players = {
    byId: (id: number) => db.get(id),
    all: () => [...db.values()],
    persist: () => undefined,
    onCreated: (fn: (rec: PlayerRecord) => void) => { hook = fn; },
    credit: (id: number, amount: number) => {
      const rec = db.get(id);
      if (!rec) return null;
      rec.coins += amount;
      return rec.coins;
    },
  } as never;

  const svc = new ReferralsService(
    { webAppUrl: null } as never, players, { username: 'testbot' } as never);
  svc.onModuleInit();

  const add = (telegramId: number, refBy: number | null = null): PlayerRecord => {
    const rec = {
      telegramId, firstName: 'p' + telegramId, coins: 0,
      refBy, refJoinPaidAt: null, createdAt: Date.now(),
    } as unknown as PlayerRecord;
    db.set(telegramId, rec);
    hook?.(rec);
    return rec;
  };

  return { svc, db, add, fire: (rec: PlayerRecord) => hook?.(rec) };
}

function main(): void {
  test('друг прийшов — запрошувачу капнуло рівно раз', () => {
    const { add, fire } = make();
    const host = add(1);
    const friend = add(2, 1);
    assert.equal(host.coins, REF_JOIN_COINS);
    assert.ok(friend.refJoinPaidAt);
    // повторний виклик хука не має платити вдруге
    fire(friend);
    assert.equal(host.coins, REF_JOIN_COINS);
  });

  test('гравець без запрошувача нікому не платить', () => {
    const { add, db } = make();
    add(1);
    add(2);
    assert.equal(db.get(1)!.coins, 0);
  });

  test('запрошувача немає — виплати немає й ознака не ставиться', () => {
    const { add } = make();
    const friend = add(2, 1);
    assert.equal(friend.refJoinPaidAt, null);
  });

  test('список друзів показує, за кого скільки отримано', () => {
    const { svc, add } = make();
    const host = add(1);
    add(2, 1);
    add(3, 1);
    const st = svc.state(host);
    assert.equal(st.friends.length, 2);
    assert.ok(st.friends.every((f) => f.earned === REF_JOIN_COINS));
    assert.equal(st.earned, REF_JOIN_COINS * 2);
  });

  test('чужий гравець у список не потрапляє', () => {
    const { svc, add } = make();
    const host = add(1);
    add(2, 1);
    const other = add(3);
    add(4, 3);
    assert.equal(svc.state(host).friends.length, 1);
    assert.equal(svc.state(other).friends.length, 1);
  });

  test('посилання збирається з імені бота', () => {
    const { svc, add } = make();
    const host = add(7);
    assert.equal(svc.link(host), 'https://t.me/testbot?start=ref_7');
    assert.equal(svc.code(host), '7');
  });

  console.log(failed ? `\n${failed} провалено` : '\nусе зійшлось');
  if (failed) process.exit(1);
}

main();
