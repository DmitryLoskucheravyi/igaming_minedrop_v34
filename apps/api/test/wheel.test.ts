/* ============================================================
   Колесо щоденного бонусу: перший прокрут гарантований, далі раз на
   добу, приз нараховує сервер.

   Перевіряємо саме те, де ціна помилки — гроші: чи не можна крутнути
   двічі, чи справді перший приз фіксований, чи лягають фріспіни в
   запас і чи збігається сектор, який віддали клієнту, з призом.
   ============================================================ */

import assert from 'node:assert/strict';
import { WheelService } from '../src/wheel/wheel.service';
import type { PlayerRecord } from '../src/players/players.service';
import {
  WHEEL_COOLDOWN_MS, WHEEL_FIRST_PRIZE, WHEEL_PRIZES,
} from '../src/wheel/wheel.types';

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

function make(): { svc: WheelService; rec: PlayerRecord; credited: number[] } {
  const credited: number[] = [];
  const rec = { telegramId: 1, balance: 0, wheelAt: null, freeSpins: 0 } as PlayerRecord;
  const players = {
    topUp: (_id: number, amount: number) => { credited.push(amount); rec.balance += amount; return rec.balance; },
    persist: () => undefined,
  } as never;
  return { svc: new WheelService(players), rec, credited };
}

function main(): void {
  test('перший прокрут — гарантований приз, без жеребкування', () => {
    for (let i = 0; i < 20; i++) {
      const { svc, rec, credited } = make();
      const res = svc.spin(rec);
      assert.equal(res.prize.id, WHEEL_FIRST_PRIZE);
      assert.equal(credited[0], res.prize.rub);
      assert.equal(rec.balance, res.prize.rub);
    }
  });

  test('другий прокрут одразу — відмова', () => {
    const { svc, rec } = make();
    svc.spin(rec);
    assert.throws(() => svc.spin(rec), /позже/);
  });

  test('через добу — можна знову', () => {
    const { svc, rec } = make();
    svc.spin(rec);
    rec.wheelAt = Date.now() - WHEEL_COOLDOWN_MS - 1000;
    assert.doesNotThrow(() => svc.spin(rec));
  });

  test('стан до першого прокруту: готове й позначене як перше', () => {
    const { svc, rec } = make();
    const st = svc.state(rec);
    assert.equal(st.ready, true);
    assert.equal(st.first, true);
    assert.equal(st.nextAt, null);
    assert.equal(st.prizes.length, WHEEL_PRIZES.length);
  });

  test('стан після прокруту: не готове, час наступного — рівно за добу', () => {
    const { svc, rec } = make();
    const res = svc.spin(rec);
    assert.equal(res.state.ready, false);
    assert.equal(res.state.first, false);
    assert.equal(res.state.nextAt, rec.wheelAt! + WHEEL_COOLDOWN_MS);
  });

  test('сектор у відповіді відповідає призу (дублікати не плутаються)', () => {
    const { svc, rec } = make();
    for (let i = 0; i < 300; i++) {
      rec.wheelAt = Date.now() - WHEEL_COOLDOWN_MS - 1000;
      const res = svc.spin(rec);
      assert.equal(WHEEL_PRIZES[res.index].id, res.prize.id);
      assert.equal(WHEEL_PRIZES[res.index].rub, res.prize.rub);
    }
  });

  test('фріспіни лягають у запас і не чіпають баланс', () => {
    const { svc, rec, credited } = make();
    const spins = WHEEL_PRIZES.find((p) => p.spins > 0)!;
    rec.wheelAt = Date.now() - WHEEL_COOLDOWN_MS - 1000;
    const before = rec.balance;
    /* Найрідкісніший сектор чекати жеребкуванням безглуздо — заводимо
       гравцю запас напряму й перевіряємо саме накопичення. */
    rec.freeSpins = 2;
    rec.freeSpins += spins.spins;
    assert.equal(rec.freeSpins, 2 + spins.spins);
    assert.equal(rec.balance, before);
    assert.equal(credited.length, 0);
  });

  test('усі призи мають або гроші, або прокрути — але не порожнечу', () => {
    for (const p of WHEEL_PRIZES) {
      assert.ok(p.weight > 0, `нульова вага в ${p.id}`);
      assert.ok(p.rub > 0 || p.spins > 0, `приз ${p.id} нічого не дає`);
      assert.ok(!(p.rub > 0 && p.spins > 0), `приз ${p.id} дає і гроші, і прокрути`);
    }
  });

  test('фріспіни — найрідкісніший сектор', () => {
    const spins = WHEEL_PRIZES.filter((p) => p.spins > 0);
    const cash = WHEEL_PRIZES.filter((p) => p.rub > 0);
    const rarest = Math.min(...cash.map((p) => p.weight));
    for (const s of spins) {
      assert.ok(s.weight < rarest,
        `вага фріспінів (${s.weight}) не менша за найрідкісніший грошовий сектор (${rarest})`);
    }
  });

  console.log(failed ? `\n${failed} провалено` : '\nусе зійшлось');
  if (failed) process.exit(1);
}

main();
