/* ============================================================
   ЗАМКНЕНИЙ БОНУС І КУПЛЕНІ ПРОКРУТИ.

   ВЛАСНІ ГРОШІ ВІДІГРАШУ НЕ ВИМАГАЮТЬ — депозит виводиться вільно.
   Умови стоять лише на подарованих грошах:
     bonusLocked/bonusTarget — БОНУСНІ гроші (x10). Вивід не
       закривають, але й самі не виводяться, доки не відіграні;
     turnover — пробіг ставок, відносно якого ставиться ціль;
     buySpins — куплений пакет прокрутів, виграш із якого лягає
       бонусними грошима.

   Перевіряємо арифметику лічильників: саме тут ціна помилки — або
   людина не може забрати своє, або дірка, заради якої все це й
   робилось.
   ============================================================ */

import assert from 'node:assert/strict';
import { PlayersService, type PlayerRecord } from '../src/players/players.service';
import { REF_BONUS_WAGER_X } from '../src/referrals/referrals.service';
import { FS_PACK, spinsPrice } from '../src/spins/spins.types';

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

/* PlayersService без бази: MongoService, який ніколи не дає з'єднання.
   Уся перевірена тут логіка — арифметика в пам'яті, сховище до неї
   стосунку не має. */
function makePlayers(): { svc: PlayersService; rec: PlayerRecord } {
  const svc = new PlayersService({ ready: async () => null } as never);
  const rec = svc.findOrCreate({ id: 1, firstName: 'p1' } as never);
  return { svc, rec };
}

function main(): void {
  test('депозит виводиться без жодного відіграшу', () => {
    const { svc, rec } = makePlayers();
    rec.balance = 5000;                        // ніби щойно поповнив
    assert.equal(svc.locked(rec), 0);
    assert.equal(svc.withdrawable(rec), 5000);
  });

  test('оборот накопичується зі ставок', () => {
    const { svc, rec } = makePlayers();
    svc.noteWager(rec, 200);
    svc.noteWager(rec, 300);
    assert.equal(rec.turnover, 500);
  });

  test('подарований прокрут (cost 0) оборот не рухає', () => {
    const { svc, rec } = makePlayers();
    svc.noteWager(rec, 0);
    assert.equal(rec.turnover, 0);
  });

  test('бонус замикається на балансі, але грати ним можна', () => {
    const { svc, rec } = makePlayers();
    rec.balance = 0;
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');
    assert.equal(rec.balance, 200, 'бонус має лягти на баланс');
    assert.equal(svc.locked(rec), 200, 'і бути замкненим');
    assert.equal(svc.withdrawable(rec), 0, 'виводити нічого');
  });

  test('свої гроші поверх бонусу виводяться, бонус — ні', () => {
    const { svc, rec } = makePlayers();
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');
    rec.balance += 400;                       // свої, вже відіграні
    assert.equal(svc.withdrawable(rec), 400);
  });

  test('відіграв ціль — замок спадає з усього, що лишилось', () => {
    const { svc, rec } = makePlayers();
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');   // ціль 2000
    svc.noteWager(rec, 1999);
    assert.equal(svc.locked(rec), 200, 'ще рано');
    svc.noteWager(rec, 1);
    assert.equal(svc.locked(rec), 0);
    assert.equal(svc.withdrawable(rec), rec.balance);
  });

  test('програв бонус — замок не висить на порожньому балансі', () => {
    const { svc, rec } = makePlayers();
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');
    rec.balance = 50;                          // програв більшу частину
    assert.equal(svc.locked(rec), 50, 'замикати більше немає чого');
    assert.equal(svc.withdrawable(rec), 0);
  });

  test('другий бонус подовжує ціль, а не скидає прогрес', () => {
    const { svc, rec } = makePlayers();
    svc.grantBonus(1, 100, REF_BONUS_WAGER_X, 'перший');  // ціль 1000
    svc.noteWager(rec, 600);
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'другий');  // +2000 до цілі
    assert.equal(rec.bonusLocked, 300);
    assert.equal(rec.bonusTarget, 3000, 'ціль = 1000 + 2000, прогрес не згорів');
    svc.noteWager(rec, 2400);
    assert.equal(svc.locked(rec), 0);
  });

  test('пакет фріспінів: ціна списується, прокрути видаються', () => {
    const { svc, rec } = makePlayers();
    rec.balance = 10_000;
    const res = svc.buySpins(rec, 100);
    assert.equal(res.left, FS_PACK);
    assert.equal(res.bet, 100);
    assert.equal(rec.balance, 10_000 - spinsPrice(100));
  });

  test('пакет не купується без грошей', () => {
    const { svc, rec } = makePlayers();
    rec.balance = 10;
    assert.throws(() => svc.buySpins(rec, 100), /Недостаточно/);
    assert.equal(rec.buySpins, 0);
  });

  test('ціна пакета йде в оборот — це ставка', () => {
    const { svc, rec } = makePlayers();
    rec.balance = 10_000;
    svc.buySpins(rec, 100);
    assert.equal(rec.turnover, spinsPrice(100));
  });

  test('поки бонус не відіграно, стеля ставки — 10% від нього', () => {
    const { svc, rec } = makePlayers();
    assert.equal(svc.maxBet(rec), 0, 'без бонусу обмеження немає');
    svc.grantBonus(1, 2000, REF_BONUS_WAGER_X, 'тест');
    assert.equal(svc.maxBet(rec), 200);
    /* Дрібний бонус не має опускати стелю нижче за мінімальну ставку —
       інакше грати ним стало б неможливо. */
    const small = makePlayers();
    small.svc.grantBonus(1, 50, REF_BONUS_WAGER_X, 'тест');
    assert.equal(small.svc.maxBet(small.rec), 10);
  });

  test('бонус згорає після терміну — разом із замкненою сумою', () => {
    const { svc, rec } = makePlayers();
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');
    rec.balance += 500;                        // 200 бонусних + 500 своїх
    rec.bonusUntil = Date.now() - 1000;        // термін вийшов
    assert.equal(svc.locked(rec), 0, 'замок має зникнути');
    assert.equal(rec.balance, 500, 'згоріти мав рівно бонус');
  });

  test('згорає не більше за баланс — своє не чіпаємо', () => {
    const { svc, rec } = makePlayers();
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');
    rec.balance = 80;                          // більшу частину програв
    rec.bonusUntil = Date.now() - 1000;
    svc.settleBonus(rec);
    assert.equal(rec.balance, 0);
  });

  test('стеля виводу з бонусу зрізає надлишок при відкритті', () => {
    const { svc, rec } = makePlayers();
    rec.balance = 0;
    svc.grantBonus(1, 100, REF_BONUS_WAGER_X, 'тест');  // стеля 0 + 100*10
    rec.balance = 5000;                        // спіймав велику кірку
    svc.noteWager(rec, 1000);                  // і відіграв ціль
    assert.equal(rec.balance, 1000, 'віддаємо не більше за стелю циклу');
    assert.equal(svc.locked(rec), 0);
  });

  test('стеля рахується від балансу на момент нарахування', () => {
    const { svc, rec } = makePlayers();
    rec.balance = 3000;                        // свої, до бонусу
    svc.grantBonus(1, 100, REF_BONUS_WAGER_X, 'тест');
    svc.noteWager(rec, 1000);
    assert.equal(rec.balance, 3100, 'свої гроші стеля не чіпає');
  });

  console.log(failed ? `\n${failed} провалено` : '\nусе зійшлось');
  if (failed) process.exit(1);
}

main();
