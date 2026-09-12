/* ============================================================
   ПРОМОКОДИ: перевірка коду при створенні заявки й нарахування
   надбавки при її погодженні.

   Перевіряємо те, де ціна помилки — гроші:
     - надбавка йде БОНУСОМ із відіграшем, а не готівкою;
     - відсоток заморожений у заявці: вимкнули код — обіцянка лишилась;
     - невідомий і вимкнений код відповідають ОДНАКОВО (щоб CRM не
       ставала довідником для того, хто перебирає чужі коди);
     - код без заявки нічого не нараховує.
   ============================================================ */

import assert from 'node:assert/strict';
import { PromosService } from '../src/promos/promos.service';
import { PROMO_WAGER_X, normalizeCode } from '../src/promos/promo.types';

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

const threw = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return (e as Error).message; }
};

/* Стенд повторює рівно те, чим користується сервіс: нарахування бонусу
   і відсутність бази (dev без MONGO_URL — штатний режим, ready() віддає
   null, сховище лишається в пам'яті). */
function make() {
  const grants: { id: number; rub: number; x: number; why: string }[] = [];
  const players = {
    grantBonus: (id: number, rub: number, x: number, why: string) =>
      grants.push({ id, rub, x, why }),
  } as never;
  const mongo = { ready: () => Promise.resolve(null) } as never;
  const svc = new PromosService(mongo, players);
  return { svc, grants };
}

console.log('\nПРОМОКОДИ\n');

test('код нормалізується: регістр і пробіли не мають значення', () => {
  assert.equal(normalizeCode('  bonus50 '), 'BONUS50');
});

test('заведення коду: відсоток і лічильники з нуля', () => {
  const { svc } = make();
  const p = svc.add('bonus50', 50);
  assert.equal(p.code, 'BONUS50');
  assert.equal(p.percent, 50);
  assert.equal(p.active, true);
  assert.equal(p.used, 0);
  assert.equal(p.granted, 0);
});

test('однаковий код удруге не заводиться', () => {
  const { svc } = make();
  svc.add('SALE', 10);
  assert.match(String(threw(() => svc.add('sale', 20))), /уже есть/);
});

test('кирилиця у коді не приймається', () => {
  const { svc } = make();
  assert.match(String(threw(() => svc.add('БОНУС', 10))), /латиниц/i);
});

test('відсоток поза межами не приймається', () => {
  const { svc } = make();
  assert.ok(threw(() => svc.add('A1', 0)));
  assert.ok(threw(() => svc.add('A2', 100500)));
});

test('percentFor: порожньо — це не помилка, а «коду немає»', () => {
  const { svc } = make();
  assert.equal(svc.percentFor(undefined), null);
  assert.equal(svc.percentFor('   '), null);
});

test('percentFor: живий код віддає свій відсоток', () => {
  const { svc } = make();
  svc.add('WELCOME', 25);
  assert.deepEqual(svc.percentFor(' welcome '), { code: 'WELCOME', percent: 25 });
});

test('вимкнений код відповідає так само, як неіснуючий', () => {
  const { svc } = make();
  const p = svc.add('OFF', 30);
  svc.update(p.id, { active: false });
  assert.equal(threw(() => svc.percentFor('OFF')), threw(() => svc.percentFor('НЕТ-ТАКОГО')));
});

test('надбавка йде БОНУСОМ із відіграшем, а не готівкою', () => {
  const { svc, grants } = make();
  svc.add('BONUS50', 50);
  const rub = svc.grant(7, 1000, 'BONUS50', 50);
  assert.equal(rub, 500);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].rub, 500);
  assert.equal(grants[0].x, PROMO_WAGER_X);
  assert.match(grants[0].why, /BONUS50/);
});

test('лічильники коду ростуть на кожному нарахуванні', () => {
  const { svc } = make();
  svc.add('XX', 10);
  svc.grant(1, 1000, 'XX', 10);
  svc.grant(2, 500, 'XX', 10);
  const p = svc.list().find((q) => q.code === 'XX')!;
  assert.equal(p.used, 2);
  assert.equal(p.granted, 150);
});

test('відсоток беруть із ЗАЯВКИ: вимкнений код обіцянку не скасовує', () => {
  const { svc, grants } = make();
  const p = svc.add('FROZEN', 20);
  svc.update(p.id, { active: false });
  /* Заявку створили, поки код працював, — гравцеві показали +20%. */
  assert.equal(svc.grant(9, 1000, 'FROZEN', 20), 200);
  assert.equal(grants[0].rub, 200);
});

test('видалений код обіцянку теж не скасовує — нарахування проходить', () => {
  const { svc, grants } = make();
  const p = svc.add('GONE', 20);
  svc.remove(p.id);
  assert.equal(svc.grant(9, 1000, 'GONE', 20), 200);
  assert.equal(grants.length, 1);
});

test('заявка без коду нічого не нараховує', () => {
  const { svc, grants } = make();
  assert.equal(svc.grant(1, 1000, undefined, undefined), 0);
  assert.equal(svc.grant(1, 1000, 'X', 0), 0);
  assert.equal(grants.length, 0);
});

test('зміна відсотка діє на наступні нарахування', () => {
  const { svc } = make();
  const p = svc.add('MOVE', 10);
  assert.equal(svc.percentFor('MOVE')!.percent, 10);
  svc.update(p.id, { percent: 40 });
  assert.equal(svc.percentFor('MOVE')!.percent, 40);
});

console.log(failed ? `\n${failed} провалено\n` : '\nусе добре\n');
process.exit(failed ? 1 : 0);
