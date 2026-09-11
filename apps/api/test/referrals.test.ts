/* ============================================================
   Реферальні виплати: за прихід друга і за його депозити від порога.

   Перевіряємо саме те, де ціна помилки — гроші: чи не платиться те
   саме двічі, чи не платиться нижче порога, чи складаються дрібні
   депозити й чи не нараховується виплата, коли запрошувача вже немає.
   ============================================================ */

import assert from 'node:assert/strict';
import {
  ReferralsService, REF_JOIN_RUB, REF_DEPOSIT_RUB, REF_DEPOSIT_MIN, REF_BONUS_WAGER_X,
} from '../src/referrals/referrals.service';
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
   поповнення й збереження. Створення запису (і саму прив'язку refBy)
   робить PlayersService, тому тут воно імітується прямо. */
function make() {
  const db = new Map<number, PlayerRecord>();
  let hook: ((rec: PlayerRecord) => void) | null = null;

  /* Реферальні гроші приходять БОНУСОМ (баланс + замок на відіграш).
     Стенд повторює лише видиму частину — нарахування й запис виклику;
     арифметику замка перевіряє wager.test. */
  const wagered: [number, number, number][] = [];
  const players = {
    grantBonus: (id: number, rub: number, x: number) => {
      const rec = db.get(id);
      if (!rec) return;
      rec.balance += rub;
      wagered.push([id, rub, x]);
    },
    byId: (id: number) => db.get(id),
    all: () => [...db.values()],
    persist: () => undefined,
    onCreated: (fn: (rec: PlayerRecord) => void) => { hook = fn; },
    topUp: (id: number, amount: number) => {
      const rec = db.get(id);
      if (!rec) return null;
      rec.balance += amount;
      return rec.balance;
    },
  } as never;

  const svc = new ReferralsService(
    { webAppUrl: null } as never, players, { username: 'testbot' } as never);
  svc.onModuleInit();

  const add = (telegramId: number, refBy: number | null = null): PlayerRecord => {
    const rec = {
      telegramId, firstName: 'p' + telegramId, balance: 0,
      refBy, refJoinPaidAt: null, refDepositPaidAt: null, refDeposited: 0,
      createdAt: Date.now(),
    } as PlayerRecord;
    db.set(telegramId, rec);
    hook?.(rec);
    return rec;
  };

  return { svc, db, add, wagered };
}

function main(): void {
  test('друг прийшов — запрошувачу капнуло рівно раз', () => {
    const { svc, add } = make();
    const host = add(1);
    const friend = add(2, 1);
    assert.equal(host.balance, REF_JOIN_RUB);
    assert.ok(friend.refJoinPaidAt);
    // повторний виклик хука (перезапит /me тощо) не має платити вдруге
    svc.onDeposit(999, REF_DEPOSIT_MIN);
    assert.equal(host.balance, REF_JOIN_RUB);
  });

  test('депозит від порога — доплата, і теж лише раз', () => {
    const { svc, add } = make();
    const host = add(1);
    add(2, 1);
    svc.onDeposit(2, REF_DEPOSIT_MIN);
    assert.equal(host.balance, REF_JOIN_RUB + REF_DEPOSIT_RUB);
    svc.onDeposit(2, REF_DEPOSIT_MIN);
    svc.onDeposit(2, 10_000);
    assert.equal(host.balance, REF_JOIN_RUB + REF_DEPOSIT_RUB);
  });

  test('обидві виплати приходять бонусом із відіграшем x10', () => {
    const { svc, add, wagered } = make();
    add(1);
    add(2, 1);                                   // прихід друга
    svc.onDeposit(2, REF_DEPOSIT_MIN);           // і його депозит
    assert.deepEqual(wagered, [
      [1, REF_JOIN_RUB, REF_BONUS_WAGER_X],
      [1, REF_DEPOSIT_RUB, REF_BONUS_WAGER_X],
    ]);
  });

  test('депозит нижче порога — доплати немає', () => {
    const { svc, add } = make();
    const host = add(1);
    add(2, 1);
    svc.onDeposit(2, REF_DEPOSIT_MIN - 1);
    assert.equal(host.balance, REF_JOIN_RUB, 'заплатили за депозит нижче порога');
  });

  test('дрібні депозити складаються до порога', () => {
    const { svc, add } = make();
    const host = add(1);
    const friend = add(2, 1);
    const part = Math.ceil(REF_DEPOSIT_MIN / 3);
    svc.onDeposit(2, part);
    svc.onDeposit(2, part);
    assert.equal(host.balance, REF_JOIN_RUB, 'заплатили раніше, ніж набрався поріг');
    svc.onDeposit(2, part);
    assert.equal(host.balance, REF_JOIN_RUB + REF_DEPOSIT_RUB);
    assert.ok(friend.refDeposited >= REF_DEPOSIT_MIN);
  });

  test('гравець без запрошувача нікому не платить', () => {
    const { svc, add, db } = make();
    add(1);
    add(2);
    svc.onDeposit(2, REF_DEPOSIT_MIN);
    assert.equal(db.get(1)!.balance, 0);
  });

  test('запрошувача видалили — виплати немає й ознака не ставиться', () => {
    const { svc, add, db } = make();
    add(1);
    const friend = add(2, 1);
    db.delete(1);
    friend.refJoinPaidAt = null;
    svc.onDeposit(2, REF_DEPOSIT_MIN);
    assert.equal(friend.refDepositPaidAt, null);
  });

  test('список друзів показує, за кого скільки отримано', () => {
    const { svc, add } = make();
    const host = add(1);
    add(2, 1);
    add(3, 1);
    svc.onDeposit(3, REF_DEPOSIT_MIN);
    const st = svc.state(host);
    assert.equal(st.friends.length, 2);
    const paid = st.friends.find((f) => f.telegramId === 3)!;
    const notYet = st.friends.find((f) => f.telegramId === 2)!;
    assert.equal(paid.earned, REF_JOIN_RUB + REF_DEPOSIT_RUB);
    assert.ok(paid.depositedAt);
    assert.equal(notYet.earned, REF_JOIN_RUB);
    assert.equal(notYet.depositedAt, null);
    assert.equal(st.earned, REF_JOIN_RUB * 2 + REF_DEPOSIT_RUB);
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
