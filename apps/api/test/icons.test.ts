/* ============================================================
   ІКОНКИ МЕРЕЖ І МОНЕТ — чи є файл під кожен пункт каталогу.

   Каталог живе на сервері (payments/networks.ts), а картинки — у
   apps/web/public. Зв'язок між ними тримається на ІМЕНІ ФАЙЛУ:
   DepositModal просить `/networks/${n.id}.png`, де id — це NetworkId
   один в один. Тобто досить додати мережу в каталог і не покласти
   файл — і в гравця у виборі мережі буде дірка.

   Помітити це самому важко: компонент Icon ховається при помилці
   завантаження (і правильно робить — краще без картинки, ніж «зламане
   зображення»), тож нічого ніде не падає. Саме тому це перевіряється
   тестом, а не оком.

   Запуск: npm run test:icons -w @minedrop/api
   ============================================================ */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NETWORKS, TOKENS, type NetworkId, type TokenId } from '../src/payments/networks';

/* Від apps/api/ до apps/web/public. */
const PUBLIC = resolve(process.cwd(), '../web/public');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

/* Файл є, це справді PNG і він не обрізаний.

   Перевіряємо не лише наявність: підмінений або недовантажений файл
   так само мовчки зникне з екрана, як і відсутній, і шукати причину
   доведеться довго. */
function checkPng(rel: string): { w: number; h: number; kb: number } {
  const file = resolve(PUBLIC, rel);
  assert.ok(existsSync(file), `немає файлу apps/web/public/${rel}`);
  const b = readFileSync(file);
  assert.ok(b.subarray(0, 8).equals(PNG_SIG), `${rel} — це не PNG`);
  /* Останні 12 байт справного PNG — довжина(4) + 'IEND'(4) + CRC(4). */
  assert.equal(b.toString('ascii', b.length - 8, b.length - 4), 'IEND',
    `${rel} обрізаний: немає кінцевого блоку`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), kb: Math.round(b.length / 1024) };
}

function main(): void {
  console.log('\nМОНЕТИ\n');
  for (const id of Object.keys(TOKENS) as TokenId[]) {
    test(`coins/${id}.png`, () => {
      const { w, h, kb } = checkPng(`coins/${id}.png`);
      assert.ok(w >= 64 && h >= 64, `${w}×${h} — замало, іконка буде митою на ретіні`);
    void kb;
    });
  }

  console.log('\nМЕРЕЖІ\n');
  for (const id of Object.keys(NETWORKS) as NetworkId[]) {
    test(`networks/${id}.png (${NETWORKS[id].name})`, () => {
      const { w, h } = checkPng(`networks/${id}.png`);
      assert.ok(w >= 64 && h >= 64, `${w}×${h} — замало, іконка буде митою на ретіні`);
    });
  }

  /* Іконки показуються розміром під тридцять пікселів, тому кожен
     зайвий кілобайт тут — це чистий програш на відкритті мініапса,
     де зв'язок часто мобільний. Не помилка, але сказати треба. */
  console.log('\nВАГА\n');
  const files = [
    ...Object.keys(TOKENS).map((id) => `coins/${id}.png`),
    ...Object.keys(NETWORKS).map((id) => `networks/${id}.png`),
  ].filter((rel) => existsSync(resolve(PUBLIC, rel)));

  const total = files.reduce((sum, rel) => sum + readFileSync(resolve(PUBLIC, rel)).length, 0);
  const kb = Math.round(total / 1024);
  console.log(`  ${files.length} іконок, разом ${kb} KB`);
  if (kb > 200) {
    console.log(`  ⚠ показуються розміром ~30 px; 128×128 вистачить із запасом,`);
    console.log(`    і це було б близько ${Math.round(files.length * 6)} KB замість ${kb}`);
  }

  console.log(failed ? `\n${failed} провалено\n` : '\nусе на місці\n');
  if (failed) process.exitCode = 1;
}

main();
