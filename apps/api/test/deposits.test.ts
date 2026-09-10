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
import { PaymentStoreRef } from '../src/payments/payment-store.ref';
import { DepositAddressPool } from '../src/payments/deposit-addresses.service';
import { PaymentRequests } from '../src/payments/payment-requests.service';
import { UnmatchedRegistry } from '../src/payments/unmatched.service';
import { TransferMatcher } from '../src/payments/transfer-matcher.service';
import type { IncomingTx } from '../src/payments/payment.types';
import type { DepositSettings, DepositMode } from '../src/settings/settings.types';

const RATE = 100;                 // ₽ за 1 USDT — рівне число, щоб рахувалось усно
const EVM = '0x1111111111111111111111111111111111111111';
const TON = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

let balances = new Map<number, number>();

const settings: DepositSettings = {
  enabled: true,
  mode: 'auto',
  networks: ['ton', 'tron', 'bsc', 'polygon', 'base'],
  tokens: ['usdt', 'usdc'],
};

/* Стенд збирає рівно те, що в продакшні збирає Nest: чотири сервіси й
   спільне сховище. Делегати нижче потрібні, щоб тести лишились про
   ПОВЕДІНКУ («переказ зіставився»), а не про те, який саме сервіс тепер
   відповідає за метод. Порядок onModuleInit той самий, що в Nest:
   сховище -> адреси -> заявки -> неопізнані. */
function make(mode: DepositMode = 'auto') {
  settings.mode = mode;
  balances = new Map([[1, 0], [2, 0]]);

  const rates = { snapshot: () => ({ rubPerUsdt: RATE }), isApproximate: () => false } as never;
  const players = {
    topUp: (id: number, amount: number) => {
      if (!balances.has(id)) return null;
      const v = balances.get(id)! + amount;
      balances.set(id, v);
      return v;
    },
  } as never;
  const cfg = { getDeposits: () => settings } as never;

  const store = new PaymentStoreRef({ ready: async () => null } as never);
  const addresses = new DepositAddressPool({ usdtTrc20Address: '' } as never, store, cfg);
  const requests = new PaymentRequests(store, rates, players, cfg, addresses);
  const unmatched = new UnmatchedRegistry(store, rates, players);
  const matcher = new TransferMatcher(requests, unmatched, cfg);

  return {
    addresses, requests, unmatched, matcher,

    async onModuleInit() {
      await store.onModuleInit();
      await addresses.onModuleInit();
      await requests.onModuleInit();
      await unmatched.onModuleInit();
    },
    onModuleDestroy: () => requests.onModuleDestroy(),

    // ---- делегати ----
    addAddress: addresses.add.bind(addresses),
    addrList: addresses.list.bind(addresses),
    updateAddress: addresses.update.bind(addresses),
    watchTargets: addresses.watchTargets.bind(addresses),
    noteScan: addresses.noteScan.bind(addresses),

    create: requests.create.bind(requests),
    activeFor: requests.activeFor.bind(requests),
    listForPlayer: requests.listForPlayer.bind(requests),
    listAll: requests.listAll.bind(requests),
    approve: requests.approve.bind(requests),
    cancelByPlayer: requests.cancelByPlayer.bind(requests),

    ingest: matcher.ingest.bind(matcher),
    settleReady: matcher.settleReady.bind(matcher),
    settle: matcher.settle.bind(matcher),

    unmatchedList: unmatched.list.bind(unmatched),
    creditUnmatched: unmatched.credit.bind(unmatched),
  };
}

type Stand = ReturnType<typeof make>;

async function init(svc: Stand): Promise<void> {
  await svc.onModuleInit();
  svc.addAddress('evm', EVM, 'test-evm');
  svc.addAddress('ton', TON, 'test-ton');
}

/* Прокрутити очікування мережі.

   Бот не зараховує переказ одразу: заявка лягає в processing і лежить
   там finalitySec своєї мережі, а потім бот перепитує мережу, чи
   переказ на місці. У тесті чекати ці секунди безглуздо, тож ставимо
   строк у минуле й проганяємо ту саму фіналізацію, що й у бою. */
function network(svc: PaymentsService, verdict: 'ok' | 'gone' | 'unknown' = 'ok'): void {
  for (const p of svc.listAll()) if (p.status === 'processing') p.confirmAt = 0;
  for (const rec of svc.settleReady()) svc.settle(rec.id, verdict);
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
    // переказ знайдено, але гроші чекають фіналізації мережі
    assert.equal(svc.activeFor(1)?.status, 'processing');
    assert.equal(balances.get(1), 0, 'до підтвердження мережею нічого не нараховано');

    network(svc);
    assert.equal(balances.get(1), 1000);
    const done = svc.listForPlayer(1)[0];
    assert.equal(done.status, 'approved');
    assert.equal(done.resolvedBy, 'bot', 'зарахував бот, а не адмін');
    await svc.onModuleDestroy();
  });

  await test('унікальний дріб розводить дві заявки на одній адресі', async () => {
    const svc = make('auto');
    await init(svc);
    const a = svc.create(1, 1000, 'polygon', 'usdt');
    const b = svc.create(2, 1000, 'polygon', 'usdt');
    assert.notEqual(a.usdtAmount, b.usdtAmount, 'суми мали розійтись хвостиком');
    svc.ingest(tx({ amount: b.usdtAmount }));
    network(svc);
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
    network(svc);
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
    network(svc);
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
    network(svc);
    assert.equal(balances.get(1), 1000);
    await svc.onModuleDestroy();
  });

  /* НЕДОПЛАТА В TON — те, чим коштувало б довіряти самому лише memo.

     У мережах із коментарем заявку знаходять за ним, а не за сумою.
     Доки на цьому все й закінчувалось, схема була така: створити
     заявку на п'ять мільйонів, надіслати 0.01 USDT із її кодом — і
     отримати п'ять мільйонів на баланс. Коментар каже, ЧИЯ заявка,
     але нічого не каже про те, чи вистачає грошей. */
  await test('TON: правильний memo з мізерною сумою НЕ зараховує заявку', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 100_000, 'ton', 'usdt');
    const r = svc.ingest(tx({ network: 'ton', to: TON, amount: 0.01, memo: p.memo }));

    assert.equal(r.kind, 'unmatched');
    network(svc);
    assert.equal(balances.get(1), 0, 'за 0.01 USDT нічого не нараховано');
    assert.match(svc.unmatchedList()[0].adminNote ?? '', /недоплата/,
      'адмін має бачити, що це саме недоплата, а не чужий переказ');
    assert.equal(svc.activeFor(1)?.status, 'pending', 'заявка лишається чекати');
    await svc.onModuleDestroy();
  });

  await test('TON: точна сума з правильним memo зараховує', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'ton', 'usdt');
    svc.ingest(tx({ network: 'ton', to: TON, amount: p.usdtAmount, memo: p.memo }));
    network(svc);
    assert.equal(balances.get(1), 1000);
    await svc.onModuleDestroy();
  });

  /* Переплату, навпаки, пропускаємо: людину ми знаємо за коментарем,
     заявку вона оплатила, а надлишок видно в paidAmount — там і
     розбирати. Кидати такий переказ у неопізнані означало б тримати
     гравця без балансу за те, що він заплатив БІЛЬШЕ. */
  await test('TON: переплата з правильним memo зараховує заявку', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'ton', 'usdt');
    svc.ingest(tx({ network: 'ton', to: TON, amount: p.usdtAmount + 3, memo: p.memo }));
    network(svc);
    assert.equal(balances.get(1), 1000, 'нараховано рівно суму заявки');
    assert.equal(svc.listForPlayer(1)[0].paidAmount, p.usdtAmount + 3,
      'надлишок має бути видно адміну');
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
    assert.equal(live.status, 'processing', 'заявка в обробці ботом');
    assert.equal(live.txid, 'semi-tx');
    assert.equal(live.paidAmount, p.usdtAmount);

    network(svc);
    assert.equal(balances.get(1), 0, 'мережа підтвердила, але гроші все одно за адміном');
    assert.ok(svc.activeFor(1)?.confirmedAt, 'підтвердження мережі має бути видно адміну');

    // адмін тисне кнопку
    svc.approve(live.id);
    assert.equal(balances.get(1), 1000);
    assert.equal(svc.listForPlayer(1)[0].resolvedBy, 'admin');
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

  console.log('\nБОТ: ОБРОБКА Й РІШЕННЯ\n');

  await test('переказ пропав із мережі — бот відхиляє сам', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    svc.ingest(tx({ amount: p.usdtAmount, txid: 'reorg-tx' }));

    network(svc, 'gone');
    const rec = svc.listForPlayer(1)[0];
    assert.equal(rec.status, 'rejected');
    assert.equal(rec.resolvedBy, 'bot', 'відхилив бот, а не адмін');
    assert.equal(balances.get(1), 0, 'за зниклий переказ нічого не нараховано');
    await svc.onModuleDestroy();
  });

  /* Не додзвонились до провайдера — це НАША проблема, а не гравцева.
     Переказ нам показав індексатор, і підвішувати чужі гроші через
     власний збій зв'язку не можна. */
  await test('перепитати не вийшло — віримо індексатору й зараховуємо', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    svc.ingest(tx({ amount: p.usdtAmount }));

    network(svc, 'unknown');
    assert.equal(balances.get(1), 1000);
    assert.equal(svc.listForPlayer(1)[0].resolvedBy, 'bot');
    await svc.onModuleDestroy();
  });

  await test('заявка в обробці ботом НЕ протухає', async () => {
    const svc = make('semi');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    svc.ingest(tx({ amount: p.usdtAmount }));

    // тридцять хвилин минуло, поки мережа підтверджувала переказ
    svc.listAll()[0].expiresAt = Date.now() - 1;
    assert.equal(svc.activeFor(1)?.status, 'processing',
      'гроші вже в мережі — протухнути заявка не має права');
    await svc.onModuleDestroy();
  });

  /* Хвостик заявки, яку бот уже взяв у роботу, мусить лишатись зайнятим.

     Інакше вийшло б так: гравець переказав, заявка пішла в processing і
     звільнила свій дріб, наступний гравець отримав РІВНО ту саму суму —
     і його переказ зіставився б навмання з однією з двох. Дріб для того
     й існує, щоб такого не було. */
  await test('дріб заявки в обробці лишається зайнятим для інших', async () => {
    const svc = make('semi');
    await init(svc);
    const first = svc.create(1, 1000, 'polygon', 'usdt');
    svc.ingest(tx({ amount: first.usdtAmount }));
    assert.equal(svc.activeFor(1)?.status, 'processing');

    const second = svc.create(2, 1000, 'polygon', 'usdt');
    assert.notEqual(second.usdtAmount, first.usdtAmount,
      'суми мали розійтись, хоч перша заявка вже й оплачена');
    await svc.onModuleDestroy();
  });

  /* Той самий гравець переказав двічі на ту саму суму. Друга сотня
     доларів — це ОКРЕМІ гроші, а не повтор першої: злити їх у ту саму
     заявку означало б з'їсти другий переказ мовчки. */
  await test('другий переказ на ту саму суму йде адміну, а не в ту саму заявку', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    svc.ingest(tx({ amount: p.usdtAmount, txid: 'first-tx' }));

    const again = svc.ingest(tx({ amount: p.usdtAmount, txid: 'second-tx' }));
    assert.equal(again.kind, 'unmatched');
    assert.equal(svc.unmatchedList().length, 1);

    network(svc);
    assert.equal(balances.get(1), 1000, 'зараховано рівно один переказ');
    await svc.onModuleDestroy();
  });

  await test('поки заявка в обробці, другу створити не можна', async () => {
    const svc = make('semi');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    svc.ingest(tx({ amount: p.usdtAmount }));
    assert.throws(() => svc.create(1, 500, 'polygon', 'usdt'), /активная заявка/,
      'інакше гравець переказав би вдруге');
    await svc.onModuleDestroy();
  });

  /* Знаки після коми з API не збіглися з каталогом. Сумі в такому
     переказі вірити не можна взагалі — помилка на порядок тут означала
     б зарахування в тисячі разів більше. */
  await test('підозріла кількість знаків не зіставляється навіть при точній сумі', async () => {
    const svc = make('auto');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    const r = svc.ingest(tx({ amount: p.usdtAmount, suspect: '18 знаков вместо 6' }));
    assert.equal(r.kind, 'unmatched');
    assert.equal(balances.get(1), 0);
    assert.equal(svc.unmatchedList()[0].adminNote, '18 знаков вместо 6');
    await svc.onModuleDestroy();
  });

  await test('рубильник вимкнено — слухати нічого, хоч режим і авто', async () => {
    const svc = make('auto');
    await init(svc);
    assert.ok(svc.watchTargets().length > 0, 'при увімкненому рубильнику адреси є');
    settings.enabled = false;
    assert.equal(svc.watchTargets().length, 0,
      'вимкнений слухач не ходить у мережу зовсім');
    settings.enabled = true;
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

  /* ---- скасування заявки самим гравцем ----
     Дві межі, і обидві про гроші: чужу заявку зняти не можна взагалі,
     а свою — тільки поки переказу немає. Заявка в processing означає,
     що кошти вже пішли в мережу, і «скасувати» її з телефона — це
     викинути їх. */
  await test('гравець знімає власну заявку, поки переказу немає', async () => {
    const svc = make('manual');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    const out = svc.cancelByPlayer(1, p.id);
    assert.equal(out.status, 'canceled');
    assert.equal(svc.activeFor(1), undefined, 'після скасування можна створити нову');
    svc.create(1, 500, 'polygon', 'usdt');
    await svc.onModuleDestroy();
  });

  await test('чужу заявку зняти не можна', async () => {
    const svc = make('manual');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    assert.throws(() => svc.cancelByPlayer(2, p.id), /не найдена/i);
    assert.equal(svc.activeFor(1)?.id, p.id, 'заявка лишилась на місці');
    await svc.onModuleDestroy();
  });

  await test('знайдений переказ скасувати не можна', async () => {
    const svc = make('manual');
    await init(svc);
    const p = svc.create(1, 1000, 'polygon', 'usdt');
    svc.ingest(tx({ amount: p.usdtAmount }));
    assert.equal(svc.activeFor(1)?.status, 'processing');
    assert.throws(() => svc.cancelByPlayer(1, p.id), /найден/i);
    await svc.onModuleDestroy();
  });

  console.log(failed ? `\n${failed} провалено\n` : '\nусе зійшлось\n');
  process.exit(failed ? 1 : 0);
}

void main();
