/* ============================================================
   Перевірка ротації admin-токенів: грейс-вікно на повтор refresh
   (загублена відповідь, а не крадіжка) і clientKey (довіра до
   X-Forwarded-For лише з loopback).
   ============================================================ */

import assert from 'node:assert/strict';
import { AdminsService } from '../src/admin/admins.service';
import { clientKey } from '../src/common/rate-limit';

let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}

function makeService(): AdminsService {
  const env = {
    adminLogin: 'root', adminEmail: 'a@b.c', adminPassword: 'correct-horse-battery-staple',
  } as never;
  const mongo = { ready: async () => null } as never;
  return new AdminsService(env, mongo);
}

async function main(): Promise<void> {
  console.log('\nCLIENTKEY — довіра до X-Forwarded-For\n');

  await test('loopback: заголовок береться до уваги', () => {
    const k = clientKey({ 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1');
    assert.equal(k, '203.0.113.9');
  });

  await test('не-loopback: заголовок ІГНОРУЄТЬСЯ, береться сокет', () => {
    const k = clientKey({ 'x-forwarded-for': '203.0.113.9' }, '198.51.100.1');
    assert.equal(k, '198.51.100.1', 'інакше зловмисник підміняє заголовок на кожен запит');
  });

  await test('спуфінг з різними XFF на кожен запит більше не дає нових ключів', () => {
    const a = clientKey({ 'x-forwarded-for': 'fake-1' }, '198.51.100.1');
    const b = clientKey({ 'x-forwarded-for': 'fake-2' }, '198.51.100.1');
    assert.equal(a, b, 'обидва мають звестись до реальної адреси сокета');
  });

  await test('IPv6-loopback (::1) теж довіряється', () => {
    const k = clientKey({ 'x-forwarded-for': '203.0.113.9' }, '::1');
    assert.equal(k, '203.0.113.9');
  });

  console.log('\nRUNROTATION — грейс-вікно на повторний refresh\n');

  await test('звичайний обмін: нова пара, стара недійсна', async () => {
    const svc = makeService();
    await svc.onModuleInit();
    const p1 = svc.login('root', 'correct-horse-battery-staple', '1.2.3.4');
    const p2 = svc.refresh(p1.refresh);
    assert.notEqual(p2.token, p1.token);
    assert.notEqual(p2.refresh, p1.refresh);
    assert.ok(svc.session(p2.token), 'новий access живий');
    assert.equal(svc.session(p1.token), null, 'старий access мертвий');
  });

  await test('повтор refresh ОДРАЗУ (загублена відповідь) -> та сама пара, сесія жива', async () => {
    const svc = makeService();
    await svc.onModuleInit();
    const p1 = svc.login('root', 'correct-horse-battery-staple', '1.2.3.4');
    const a = svc.refresh(p1.refresh);
    const b = svc.refresh(p1.refresh);   // клієнт не отримав відповідь і повторив той самий запит
    assert.equal(b.token, a.token, 'повтор у грейс-вікні мав повернути ТУ САМУ пару');
    assert.equal(b.refresh, a.refresh);
    assert.ok(svc.session(a.token), 'сесія не мала постраждати від повтору у вікні поблажки');
  });

  await test('третій виклик з першим refresh теж повертає ту саму пару (не одноразовий грант)', async () => {
    const svc = makeService();
    await svc.onModuleInit();
    const p1 = svc.login('root', 'correct-horse-battery-staple', '1.2.3.4');
    const a = svc.refresh(p1.refresh);
    const b = svc.refresh(p1.refresh);
    const c = svc.refresh(p1.refresh);
    assert.equal(c.token, a.token);
    assert.equal(c.refresh, b.refresh);
  });

  await test('повтор ПІЗНІШЕ грейс-вікна гасить усю родину', async () => {
    const svc = makeService();
    await svc.onModuleInit();
    const p1 = svc.login('root', 'correct-horse-battery-staple', '1.2.3.4');
    const a = svc.refresh(p1.refresh);
    // підміняємо usedAt у минуле, ніби пройшло 20с (грейс — 10с)
    (svc as unknown as { refreshes: Map<string, { usedAt?: number }> })
      .refreshes.get(p1.refresh)!.usedAt = Date.now() - 20_000;
    assert.throws(() => svc.refresh(p1.refresh), /сброшена/i);
    assert.equal(svc.session(a.token), null, 'уся родина мала загинути');
  });

  await test('новою парою після грейс-вікна можна користуватись як завжди', async () => {
    const svc = makeService();
    await svc.onModuleInit();
    const p1 = svc.login('root', 'correct-horse-battery-staple', '1.2.3.4');
    const a = svc.refresh(p1.refresh);
    const b = svc.refresh(a.refresh);   // звичайний, не повторний обмін
    assert.notEqual(b.token, a.token);
    assert.ok(svc.session(b.token));
  });

  console.log(failed ? `\n${failed} провалено\n` : '\nусе зійшлось\n');
  process.exit(failed ? 1 : 0);
}

void main();
