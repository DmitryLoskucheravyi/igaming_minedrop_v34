/* ============================================================
   Перевірка ЗІСТАВЛЕННЯ ПЕРЕКАЗІВ — без мережі, без ключів, без Mongo.

   PaymentsService — звичайний клас, тож замість справжніх залежностей
   підставляємо заглушки й проганяємо через ingest() ті самі випадки,
   які трапляються насправді: правильний переказ, переплата, чужа сума,
   повтор того самого txid, не та мережа в межах родини, memo в TON.

   Спостерігачів ще немає, але рішення приймає не вони, а цей код, тому
   перевіряти є що вже зараз.
   ============================================================ */

import assert from 'node:assert/strict';
import { PaymentsService, type IncomingTx } from '../src/payments/payments.service';
import type { DepositSettings, DepositMode } from '../src/settings/settings.types';

const RATE = 100;                 // ₽ за 1 USDT — рівне число, щоб рахувалось усно
const EVM = '0x1111111111111111111111111111111111111111';
const TON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

let balances = new Map<number, number>();

const settings: DepositSettings = {
  mode: 'auto',
  networks: ['ton', 'tron', 'bsc', 'polygon', 'base'],
  tokens: ['usdt', 'usdc'],
};

function make(mode: DepositMode = 'auto'): PaymentsService {
  settings.mode = mode;
  balances = new Map([[1, 0], [2, 0]]);

  const svc = new PaymentsService(
    { usdtTrc20Address: '' } as never,
    { ready: async () => null } as never,
    { snapshot: () => ({ rubPerUsdt: RATE }), isApproximate: () => false } as never,
    {
      topUp: (id: number, amount: number) => {
        if (!balances.has(id)) return null;
        const v = balances.get(id)! + amount;
        balances.set(id, v);
        return v;
      },
    } as never,
    { getDeposits: () => settings } as never,
  );
  return svc;
}

async function init(svc: PaymentsService): Promise<void> {
  await svc.onModuleInit();
  svc.addAddress('evm', EVM, 'test-evm');
  svc.addAddress('ton', TON, 'test-ton');
}

const tx = (over: Partial<IncomingTx>): IncomingTx => ({
  network: 'polygon', token: 'usdt', to: EVM, from: '0xdead',
  amount: 0, txid: 'tx-' + Math.random().toString(36).slice(2), at: Date.now(),
  ...over,
});

let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log('\nЗІСТАВЛЕННЯ ПЕРЕКАЗІВ\n');

  await test('точна сума зараховує заявку (auto)', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    const r = svc.ingest(tx({ amount: p.usdtAmount }));
    assert.equal(r.kind, 'matched');
    assert.equal(r.kind === 'matched' && r.credited, true);
    assert.equal(balances.get(1), 1000);
    await svc.onModuleDestroy();
  });

  await test('унікальний дріб розводить дві заявки на одній адресі', async () => {
    const svc = make('auto');
    await init(svc);
    const a = svc.create(1, 1000, 'polygon', 'usdt');
    const b = svc.create(2, 1000, 'polygon', 'usdt');
    assert.notEqual(a.usdtAmount, b.usdtAmount, 'суми мали розійтись хвостиком');
    svc.ingest(tx({ amount: b.usdtAmount }));
    assert.equal(balances.get(2), 1000, 'мала зарахуватись друга заявка');
    assert.equal(balances.get(1), 0, 'перша лишається чекати');
    await svc.onModuleDestroy();
  });

  await test('не та мережа в межах родини все одно зіставляється', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    // гравець обрав Polygon, а відправив у Base — адреса та сама
    const r = svc.ingest(tx({ network: 'base', amount: p.usdtAmount }));
    assert.equal(r.kind, 'matched');
    assert.equal(balances.get(1), 1000);
    await svc.onModuleDestroy();
  });

  await test('чужий токен не зіставляється', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    const r = svc.ingest(tx({ token: 'usdc', amount: p.usdtAmount }));
    assert.equal(r.kind, 'unmatched');
    assert.equal(balances.get(1), 0);
    await svc.onModuleDestroy();
  });

  await test('переплата йде в неопізнані, а не зараховує заявку', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    const r = svc.ingest(tx({ amount: p.usdtAmount + 5 }));
    assert.equal(r.kind, 'unmatched');
    assert.equal(balances.get(1), 0);
    assert.equal(svc.unmatchedList().length, 1);
    await svc.onModuleDestroy();
  });

  await test('той самий txid двічі не зараховує двічі', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    const one = tx({ amount: p.usdtAmount, txid: 'same-tx' });
    svc.ingest(one);
    const again = svc.ingest(one);
    assert.equal(again.kind, 'duplicate');
    assert.equal(balances.get(1), 1000, 'баланс мав лишитись від першого разу');
    await svc.onModuleDestroy();
  });

  await test('повтор неопізнаного txid теж не дублюється', async () => {
    const svc = make('auto');
    await init(svc);
    const t = tx({ amount: 7.77, txid: 'orphan-tx' });
    svc.ingest(t);
    assert.equal(svc.ingest(t).kind, 'duplicate');
    assert.equal(svc.unmatchedList().length, 1);
    await svc.onModuleDestroy();
  });

  await test('TON: зіставляє memo, а не суму', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'ton', 'usdt');
    assert.ok(p.memo, 'у TON заявка має отримати код-коментар');
    // сума рівно та сама, але без memo — не наша
    const nope = svc.ingest(tx({ network: 'ton', to: TON, amount: p.usdtAmount, memo: 'WRONG' }));
    assert.equal(nope.kind, 'unmatched');
    // і зовсім без коментаря — теж не наша, хоч сума й сходиться
    const bare = svc.ingest(tx({ network: 'ton', to: TON, amount: p.usdtAmount }));
    assert.equal(bare.kind, 'unmatched');
    assert.equal(balances.get(1), 0, 'до правильного memo нічого не нараховано');

    const yes = svc.ingest(tx({ network: 'ton', to: TON, amount: p.usdtAmount, memo: p.memo }));
    assert.equal(yes.kind, 'matched');
    assert.equal(balances.get(1), 1000);
    await svc.onModuleDestroy();
  });

  await test('watch: бачить, але нічого не чіпає', async () => {
    const svc = make('watch');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    const r = svc.ingest(tx({ amount: p.usdtAmount }));
    assert.equal(r.kind === 'matched' && r.credited, false);
    assert.equal(balances.get(1), 0);
    assert.equal(svc.activeFor(1)?.status, 'pending');
    assert.equal(svc.activeFor(1)?.txid, undefined, 'у watch заявка не позначається оплаченою');
    await svc.onModuleDestroy();
  });

  await test('semi: позначає оплаченою, гроші лишає адміну', async () => {
    const svc = make('semi');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    svc.ingest(tx({ amount: p.usdtAmount, txid: 'semi-tx' }));
    assert.equal(balances.get(1), 0, 'у semi гроші не нараховуються самі');
    const live = svc.activeFor(1)!;
    assert.equal(live.status, 'pending');
    assert.equal(live.txid, 'semi-tx');
    assert.equal(live.paidAmount, p.usdtAmount);
    // адмін тисне кнопку
    svc.approve(live.id);
    assert.equal(balances.get(1), 1000);
    await svc.onModuleDestroy();
  });

  await test('неопізнаний зараховується вручну за поточним курсом', async () => {
    const svc = make('auto');
    await init(svc);
    svc.ingest(tx({ amount: 12.5, txid: 'manual-tx' }));
    const row = svc.unmatchedList()[0];
    const done = svc.creditUnmatched(row.id, 1);
    assert.equal(done.status, 'credited');
    assert.equal(balances.get(1), 1250, '12.5 USDT × 100 ₽');
    assert.throws(() => svc.creditUnmatched(row.id, 1), /credited/,
      'двічі зарахувати не можна');
    await svc.onModuleDestroy();
  });

  await test('вимкнена мережа не дає створити заявку', async () => {
    const svc = make('auto');
    await init(svc);
    assert.throws(() => svc.create(1, 1000, 'arbitrum', 'usdt'), /недоступна/);
    await svc.onModuleDestroy();
  });

  await test('токена нема в цій мережі — відмова', async () => {
    const svc = make('auto');
    await init(svc);
    // у Base ми описали лише USDC
    assert.throws(() => svc.create(1, 1000, 'base', 'usdt'), /не принимается/);
    await svc.onModuleDestroy();
  });

  console.log('\nСПИСОК СПОСТЕРЕЖЕННЯ\n');

  await test('режим off — слухати нічого', async () => {
    const svc = make('off');
    await init(svc);
    assert.equal(svc.watchTargets().length, 0);
    await svc.onModuleDestroy();
  });

  await test('додана адреса потрапляє в роботу одразу', async () => {
    const svc = make('watch');
    await svc.onModuleInit();
    assert.equal(svc.watchTargets().length, 0, 'адрес ще немає');
    svc.addAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    assert.equal(svc.watchTargets().length, 1, 'без рестарту, наступним же викликом');
    await svc.onModuleDestroy();
  });

  await test('вимкнена адреса випадає зі списку', async () => {
    const svc = make('watch');
    await init(svc);
    const evm = svc.addrList().find((a) => a.family === 'evm')!;
    assert.ok(svc.watchTargets().some((t) => t.addressId === evm.id));
    svc.updateAddress(evm.id, { active: false });
    assert.equal(svc.watchTargets().some((t) => t.addressId === evm.id), false);
    await svc.onModuleDestroy();
  });

  await test('одна EVM-адреса покриває всі увімкнені EVM-мережі', async () => {
    const svc = make('watch');
    await init(svc);
    const t = svc.watchTargets().find((x) => x.family === 'evm')!;
    // у налаштуваннях тесту з EVM увімкнені bsc, polygon, base
    assert.deepEqual([...t.networks].sort(), ['base', 'bsc', 'polygon']);
    await svc.onModuleDestroy();
  });

  await test('вимкнув мережу — вона зникла зі спостереження', async () => {
    const svc = make('watch');
    await init(svc);
    settings.networks = ['ton', 'tron', 'bsc'];
    const t = svc.watchTargets().find((x) => x.family === 'evm')!;
    assert.deepEqual(t.networks, ['bsc']);
    settings.networks = ['ton', 'tron', 'bsc', 'polygon', 'base'];
    await svc.onModuleDestroy();
  });

  await test('адреса родини без увімкнених мереж не слухається', async () => {
    const svc = make('watch');
    await init(svc);
    svc.addAddress('solana', '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
    assert.equal(svc.watchTargets().some((t) => t.family === 'solana'), false,
      'solana вимкнена в налаштуваннях — слухати нічого');
    await svc.onModuleDestroy();
  });

  await test('watchFrom = момент додавання, а не нуль', async () => {
    const svc = make('watch');
    const before = Date.now();
    await init(svc);
    for (const t of svc.watchTargets()) {
      assert.ok(t.watchFrom >= before, 'інакше перший цикл підняв би всю історію гаманця');
    }
    await svc.onModuleDestroy();
  });

  await test('курсор спостерігача зберігається біля адреси', async () => {
    const svc = make('watch');
    await init(svc);
    const id = svc.watchTargets()[0].addressId;
    svc.noteScan(id, 'block-12345');
    const t = svc.watchTargets().find((x) => x.addressId === id)!;
    assert.equal(t.cursor, 'block-12345');
    assert.ok(t.scannedAt && t.scannedAt > 0);
    await svc.onModuleDestroy();
  });

  console.log(failed ? `\n${failed} провалено\n` : '\nусе зійшлось\n');
  process.exit(failed ? 1 : 0);
}

void main();
