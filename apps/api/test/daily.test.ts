/* ============================================================
   Щоденна нагорода: календарна доба, серія заходів, повторне
   отримання.

   Ціна помилки тут — або зірваний стрік у людини, яка заходила щодня,
   або нагорода двічі за добу. Обидва випадки перевіряються явно.
   ============================================================ */

import assert from 'node:assert/strict';
import { DailyService } from '../src/daily/daily.service';
import {
  DAILY_REFILL, STREAK_COINS, STREAK_DAYS, dayKey, daysBetween, nextDayAt, streakDay,
} from '../src/daily/daily.types';
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

const TZ = 'Europe/Kyiv';
const DAY = 24 * 3600 * 1000;

function make() {
  const rec = { telegramId: 1, coins: 1000, dailyDay: null, streak: 0 } as unknown as PlayerRecord;
  const players = {
    balance: () => rec.coins,
    credit: (_id: number, amount: number) => { rec.coins += amount; return rec.coins; },
  } as never;
  return { svc: new DailyService({ dailyTz: TZ } as never, players), rec };
}

function main(): void {
  test('нагороди серії: 1000, 2000, … 30 000', () => {
    assert.equal(STREAK_COINS.length, STREAK_DAYS);
    assert.equal(STREAK_COINS[0], 1000);
    assert.equal(STREAK_COINS[1], 2000);
    assert.equal(STREAK_COINS[29], 30_000);
  });

  test('доба рахується в поясі, а не в UTC', () => {
    // 22:30 UTC 1 жовтня — у Києві (UTC+3) це вже 2 жовтня
    const ms = Date.UTC(2026, 9, 1, 22, 30);
    assert.equal(dayKey(ms, 'UTC'), '2026-10-01');
    assert.equal(dayKey(ms, TZ), '2026-10-02');
  });

  test('різниця діб — через межі місяця й року', () => {
    assert.equal(daysBetween('2026-01-31', '2026-02-01'), 1);
    assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
    assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);   // з переходом на літній час
  });

  test('наступна доба — рівно опівночі в поясі', () => {
    const ms = Date.UTC(2026, 9, 1, 12, 0);       // 15:00 у Києві
    const at = nextDayAt(ms, TZ);
    assert.equal(dayKey(at, TZ), '2026-10-02');
    assert.equal(dayKey(at - 1000, TZ), '2026-10-01');
    assert.equal(at - ms, 9 * 3600 * 1000);
  });

  test('день серії: учора -> наступний, пропуск -> перший, після 30 -> знову 1', () => {
    assert.equal(streakDay(null, 0, '2026-10-01'), 1);
    assert.equal(streakDay('2026-09-30', 4, '2026-10-01'), 5);
    assert.equal(streakDay('2026-09-29', 4, '2026-10-01'), 1);
    assert.equal(streakDay('2026-09-30', STREAK_DAYS, '2026-10-01'), 1);
    assert.equal(streakDay('2026-10-01', 7, '2026-10-01'), 7);
  });

  test('перше отримання: поповнення + перший день серії', () => {
    const { svc, rec } = make();
    const res = svc.claim(rec);
    assert.equal(res.day, 1);
    assert.equal(res.total, DAILY_REFILL + STREAK_COINS[0]);
    assert.equal(rec.coins, 1000 + DAILY_REFILL + STREAK_COINS[0]);
    assert.equal(res.state.ready, false);
  });

  test('двічі за добу — відмова, баланс не змінюється', () => {
    const { svc, rec } = make();
    svc.claim(rec);
    const before = rec.coins;
    assert.throws(() => svc.claim(rec), /уже получена/);
    assert.equal(rec.coins, before);
  });

  test('заходив учора — серія продовжується', () => {
    const { svc, rec } = make();
    rec.dailyDay = dayKey(Date.now() - DAY, TZ);
    rec.streak = 6;
    assert.equal(svc.state(rec).day, 7);
    const res = svc.claim(rec);
    assert.equal(res.day, 7);
    assert.equal(res.streak, STREAK_COINS[6]);
    assert.equal(rec.streak, 7);
  });

  test('пропустив добу — серія з першого дня', () => {
    const { svc, rec } = make();
    rec.dailyDay = dayKey(Date.now() - 3 * DAY, TZ);
    rec.streak = 12;
    assert.equal(svc.claim(rec).day, 1);
  });

  console.log(failed ? `\n${failed} провалено` : '\nусе зійшлось');
  if (failed) process.exit(1);
}

main();
