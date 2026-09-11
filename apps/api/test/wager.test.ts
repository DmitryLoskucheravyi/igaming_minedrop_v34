/* ============================================================
   ДВА БАЛАНСИ, ВІДІГРАШ І ФРІСПІНИ.

   Модель узята з казино (див. players/money.ts):
     cash  — гроші гравця, виводяться будь-коли;
     bonus — подарунки й виграш безкоштовних прокрутів, спершу відіграш.

   Перевіряємо саме те, де ціна помилки — гроші: звідки списалась
   ставка, куди пішов виграш, коли знімається вимога й що лишається
   виводимим.
   ============================================================ */

import assert from 'node:assert/strict';
import { PlayersService, type PlayerRecord } from '../src/players/players.service';
import { splitPayout, splitStake } from '../src/players/money';
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
   Уся перевірена тут логіка — арифметика в пам'яті. */
function make(): { svc: PlayersService; rec: PlayerRecord } {
  const svc = new PlayersService({ ready: async () => null } as never);
  const rec = svc.findOrCreate({ id: 1, firstName: 'p1' } as never);
  rec.cash = 0;
  return { svc, rec };
}

function main(): void {
  test('розклад ставки: спершу бонус, решта готівка', () => {
    assert.deepEqual(splitStake(40, 100, 100), { fromBonus: 40, fromCash: 60 });
    assert.deepEqual(splitStake(0, 100, 50), { fromBonus: 0, fromCash: 50 });
    assert.deepEqual(splitStake(500, 100, 50), { fromBonus: 50, fromCash: 0 });
  });

  test('виплата ділиться в пропорції ставки, копійка — бонусу', () => {
    const st = { fromBonus: 40, fromCash: 60 };
    const p = splitPayout(st, 100);
    assert.equal(p.fromBonus + p.fromCash, 100, 'сума має зійтись');
    assert.equal(p.fromBonus, 40);
    /* Округлення на користь бонусу: інакше на довгій серії дрібних
       раундів бонус сам собою перетікав би у виводимі гроші. */
    const odd = splitPayout({ fromBonus: 1, fromCash: 2 }, 10);
    assert.equal(odd.fromBonus, 4);
    assert.equal(odd.fromCash, 6);
  });

  test('депозит — готівка, виводиться без відіграшу', () => {
    const { svc, rec } = make();
    svc.topUp(1, 5000);
    assert.equal(rec.cash, 5000);
    assert.equal(rec.bonus, 0);
    assert.equal(svc.withdrawable(rec), 5000);
  });

  test('бонус лягає окремо й не виводиться', () => {
    const { svc, rec } = make();
    svc.topUp(1, 1000);
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');
    assert.equal(svc.total(rec), 1200);
    assert.equal(svc.withdrawable(rec), 1000, 'своє виводиться, бонус ні');
    assert.equal(rec.wagerNeed, 2000);
  });

  test('ставка йде з бонусу першою, виграш повертається туди ж', () => {
    const { svc, rec } = make();
    svc.topUp(1, 1000);
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');
    const split = svc.stake(rec, 100);
    assert.deepEqual(split, { fromBonus: 100, fromCash: 0 });
    assert.equal(rec.bonus, 100);
    assert.equal(rec.cash, 1000, 'готівку не чіпали');
    svc.payout(rec, split, 300);
    assert.equal(rec.bonus, 400, 'виграш бонусної ставки — бонусний');
    assert.equal(rec.cash, 1000);
  });

  test('оборот росте зі ставок і знімає вимогу', () => {
    const { svc, rec } = make();
    svc.topUp(1, 10_000);
    svc.grantBonus(1, 100, REF_BONUS_WAGER_X, 'тест');   // треба 1000
    svc.noteWager(rec, 600);
    assert.equal(rec.wagerNeed, 1000);
    assert.equal(svc.withdrawable(rec), 10_000);
    svc.noteWager(rec, 400);
    assert.equal(rec.wagerNeed, 0, 'вимога знята');
    assert.equal(rec.bonus, 0);
    assert.equal(svc.withdrawable(rec), 10_100, 'бонус став готівкою');
  });

  test('без активного бонусу оборот не рахується', () => {
    const { svc, rec } = make();
    svc.topUp(1, 1000);
    svc.noteWager(rec, 500);
    assert.equal(rec.wagerDone, 0);
  });

  test('програв бонус — вимога зникає разом із ним', () => {
    const { svc, rec } = make();
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');
    svc.stake(rec, 200);                       // усе бонусом, виграшу немає
    svc.noteWager(rec, 200);
    assert.equal(rec.bonus, 0);
    assert.equal(rec.wagerNeed, 0, 'борг за гроші, яких немає, тримати нема сенсу');
  });

  test('термін вийшов — згорає бонус, готівка ціла', () => {
    const { svc, rec } = make();
    svc.topUp(1, 700);
    svc.grantBonus(1, 200, REF_BONUS_WAGER_X, 'тест');
    rec.bonusUntil = Date.now() - 1000;
    svc.settleBonus(rec);
    assert.equal(rec.bonus, 0);
    assert.equal(rec.cash, 700, 'своє згоріти не може');
    assert.equal(rec.wagerNeed, 0);
  });

  test('стеля виводу зрізає надлишок при відіграші', () => {
    const { svc, rec } = make();
    svc.grantBonus(1, 100, REF_BONUS_WAGER_X, 'тест');  // стеля 100 * 10
    rec.bonus = 5000;                                    // спіймав велику кірку
    svc.noteWager(rec, 1000);
    assert.equal(rec.cash, 1000, 'у готівку йде не більше за стелю');
    assert.equal(rec.bonus, 0);
  });

  test('стеля ставки — 10% від бонусу, але не нижче мінімальної', () => {
    const { svc, rec } = make();
    assert.equal(svc.maxBet(rec), 0, 'без бонусу обмеження немає');
    svc.grantBonus(1, 2000, REF_BONUS_WAGER_X, 'тест');
    assert.equal(svc.maxBet(rec), 200);
    const small = make();
    small.svc.grantBonus(1, 50, REF_BONUS_WAGER_X, 'тест');
    assert.equal(small.svc.maxBet(small.rec), 10);
  });

  test('фріспіни: виграш копиться й зараховується підсумком серії', () => {
    const { svc, rec } = make();
    svc.noteFreeSpinWin(rec, 120);
    svc.noteFreeSpinWin(rec, 80);
    assert.equal(rec.freeSpinWin, 200);
    assert.equal(svc.total(rec), 0, 'до кінця серії на баланс нічого не падає');

    svc.finishFreeSpins(rec, true, REF_BONUS_WAGER_X, 'колесо');
    assert.equal(rec.bonus, 200, 'подаровані прокрути дають бонусні гроші');
    assert.equal(rec.wagerNeed, 2000, 'вимога рахується від ПІДСУМКУ серії');
    assert.equal(rec.freeSpinWin, 0);
  });

  test('куплений пакет: виграш — готівка, без відіграшу', () => {
    const { svc, rec } = make();
    svc.noteFreeSpinWin(rec, 3000);
    svc.finishFreeSpins(rec, false, 0, 'куплений пакет');
    assert.equal(rec.cash, 3000);
    assert.equal(rec.wagerNeed, 0);
    assert.equal(svc.withdrawable(rec), 3000);
  });

  test('купівля пакета: ціна списана, прокрути видані, оборот зарахований', () => {
    const { svc, rec } = make();
    svc.topUp(1, 10_000);
    /* Великий бонус, щоб вимога не закрилась самою покупкою й було
       видно саме зарахування обороту. */
    svc.grantBonus(1, 5000, REF_BONUS_WAGER_X, 'тест');
    const res = svc.buySpins(rec, 100);
    assert.equal(res.left, FS_PACK);
    assert.equal(rec.wagerDone, spinsPrice(100), 'ціна пакета — це ставка');
    assert.equal(rec.bonus, 5000, 'бонусні гроші на покупку не йдуть');
    assert.equal(rec.cash, 10_000 - spinsPrice(100));
  });

  test('пакет не купується за бонусні гроші', () => {
    const { svc, rec } = make();
    svc.grantBonus(1, 50_000, REF_BONUS_WAGER_X, 'тест');
    /* Бонусу вистачає з надлишком, готівки немає — і саме тому покупка
       має відмовити: інакше бонус перетікав би у виводимий виграш. */
    assert.throws(() => svc.buySpins(rec, 100), /Недостаточно/);
  });

  test('пакет не купується без грошей', () => {
    const { svc, rec } = make();
    rec.cash = 10;
    assert.throws(() => svc.buySpins(rec, 100), /Недостаточно/);
    assert.equal(rec.buySpins, 0);
  });

  test('вивід бере лише готівку', () => {
    const { svc, rec } = make();
    svc.topUp(1, 900);
    svc.grantBonus(1, 300, REF_BONUS_WAGER_X, 'тест');
    const bad = svc.charge(1, 1000, 'вивід');
    assert.equal(bad.ok, false, 'бонус виводити не можна');
    const good = svc.charge(1, 900, 'вивід');
    assert.equal(good.ok, true);
    assert.equal(rec.bonus, 300, 'бонус лишився на місці');
  });

  test('публічний зріз показує суму й розклад', () => {
    const { svc, rec } = make();
    svc.topUp(1, 400);
    svc.grantBonus(1, 100, REF_BONUS_WAGER_X, 'тест');
    const st = svc.publicState(rec);
    assert.equal(st.balance, 500, 'гравець бачить одне число');
    assert.equal(st.cash, 400);
    assert.equal(st.bonus, 100);
  });

  console.log(failed ? `\n${failed} провалено` : '\nусе зійшлось');
  if (failed) process.exit(1);
}

main();
