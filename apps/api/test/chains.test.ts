/* ============================================================
   ЧИТАЧІ МЕРЕЖ — дві різні перевірки в одному файлі.

   1. ЧИСТІ ФУНКЦІЇ — без мережі й без ключів, ганяються завжди.
      Саме тут ховаються помилки, які коштують грошей: неточність у
      перерахунку сирої суми означає не «трохи не так», а зарахування
      не тієї суми, а невпізнана форма TON-адреси — що жоден переказ
      не знайдеться взагалі.

   2. ЖИВІ МЕРЕЖІ — якщо в оточенні є ключі. Тут перевіряється те, що
      з тестів на заглушках не видно ніколи: чи не змінив провайдер
      форму відповіді. Адреси взяті чужі й публічні (біржові гаманці) —
      власних для цього не треба, читання нічого не змінює.

      Без ключів ця частина просто пропускається: у CI їх немає, і
      падати через це тест не має.

   Запуск: npm run test:chains -w @minedrop/api
   ============================================================ */

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fromRaw } from '../src/watcher/chain.types';
import { evmReader } from '../src/watcher/chains/evm';
import { tronReader } from '../src/watcher/chains/tron';
import { tonReader, tonRaw } from '../src/watcher/chains/ton';
import { solanaReader } from '../src/watcher/chains/solana';
import type { ChainReader, ScanContext } from '../src/watcher/chain.types';

for (const p of ['../../.env', '.env']) {
  try {
    process.loadEnvFile(resolve(process.cwd(), p));
    break;
  } catch { /* немає файлу — працюємо на змінних оточення */ }
}

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

/* Публічні біржові гаманці. Потрібні тільки тим, що вони ЖИВІ й на них
   реально приходять USDT/USDC — своїх адрес для перевірки читання не
   треба, а на чужих одразу видно, що формат відповіді не змінився. */
const LIVE: { name: string; reader: ChainReader; env: string; ctx: Omit<ScanContext, 'key'> }[] = [
  {
    name: 'EVM / Ankr', reader: evmReader, env: 'ANKR_KEY',
    ctx: {
      address: '0x28C6c06298d514Db089934071355E5743bf21d60',
      networks: ['bsc', 'polygon', 'base', 'arbitrum', 'optimism', 'avalanche'],
      tokens: ['usdt', 'usdc'], since: 0,
    },
  },
  {
    name: 'TRON / TronGrid', reader: tronReader, env: 'TRONGRID_KEY',
    ctx: {
      address: 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G',
      networks: ['tron'], tokens: ['usdt', 'usdc'], since: 0,
    },
  },
  {
    name: 'TON / TonAPI', reader: tonReader, env: 'TONAPI_KEY',
    ctx: {
      address: '0:9ee8e6653451d75816a2e55dc2cd8b1d3baf32651d8631d31858ee8d275c188b',
      networks: ['ton'], tokens: ['usdt'], since: 0,
    },
  },
  {
    name: 'Solana / Helius', reader: solanaReader, env: 'HELIUS_KEY',
    ctx: {
      address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      networks: ['solana'], tokens: ['usdt', 'usdc'], since: 0,
    },
  },
];

async function main(): Promise<void> {
  console.log('\nСИРА СУМА -> ЧИСЛО\n');

  await test('шість знаків', () => {
    assert.equal(fromRaw('12345678', 6), 12.345678);
    assert.equal(fromRaw('1', 6), 0.000001);
    assert.equal(fromRaw('0', 6), 0);
  });

  /* У BSC в обох токенів 18 знаків, і сира сума там виходить за межі
     точного цілого в JS. Ділення Number(raw)/1e18 почало б губити
     копійки — саме ті, якими заявка й ідентифікується. */
  await test('вісімнадцять знаків не втрачають дріб суми', () => {
    assert.equal(fromRaw('1000100000000000000', 18), 1.0001);
    assert.equal(fromRaw('12345678000000000000', 18), 12.345678);
    assert.equal(fromRaw('1000000000000000000000', 18), 1000);
  });

  await test('ціла частина без дробу', () => {
    assert.equal(fromRaw('5000000', 6), 5);
    assert.equal(fromRaw('123', 0), 123);
  });

  console.log('\nАДРЕСА TON: ТРИ ЗАПИСИ ОДНОГО Й ТОГО САМОГО\n');

  /* EQ… і UQ… відрізняються лише прапорцем «що робити при помилці» —
     це ОДНА адреса. Не звести їх до спільного вигляду означало б, що
     гаманець, заведений як UQ…, не збігся б із тим, що віддає API, і
     жоден переказ на нього не знайшовся б. */
  await test('EQ, UQ і сирий запис зводяться до одного', () => {
    const raw = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';
    assert.equal(tonRaw('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'), raw);
    assert.equal(tonRaw('UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_pOZ'), raw);
    assert.equal(tonRaw(raw), raw);
    assert.equal(tonRaw(raw.toUpperCase().replace('0:', '0:')), raw);
  });

  await test('сміття не проходить за адресу', () => {
    assert.equal(tonRaw(''), null);
    assert.equal(tonRaw('0x28C6c06298d514Db089934071355E5743bf21d60'), null);
    assert.equal(tonRaw('TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G'), null);
  });

  const havekeys = LIVE.filter((l) => !!process.env[l.env]?.trim());
  if (!havekeys.length) {
    console.log('\nЖИВІ МЕРЕЖІ: ключів немає, пропускаю\n');
  } else {
    console.log('\nЖИВІ МЕРЕЖІ (читання чужих публічних гаманців)\n');
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const live of havekeys) {
      await test(`${live.name}: відповідь читається`, async () => {
        const { txs, cursor } = await live.reader.scan({
          ...live.ctx, since, key: process.env[live.env]!.trim(),
        });
        assert.ok(cursor, 'без курсора наступний цикл перечитував би все заново');
        for (const tx of txs) {
          assert.ok(tx.txid, 'без txid не буде захисту від подвійного зарахування');
          assert.ok(tx.amount > 0, `сума ${tx.amount} — розбір відповіді зламався`);
          assert.ok(tx.at > since, 'час переказу поза запитаним вікном');
          assert.ok(!tx.suspect, `знаки після коми розійшлися з каталогом: ${tx.suspect}`);
        }
        console.log(`      ${txs.length} переказ., курсор ${cursor}`);
      });
    }
  }

  console.log(failed ? `\n${failed} провалено\n` : '\nусе зійшлось\n');
  if (failed) process.exitCode = 1;
}

void main();
