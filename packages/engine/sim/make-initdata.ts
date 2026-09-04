/* Згенерувати підписаний initData — щоб перевіряти живий API так,
   як це робить телеграм.

     tsx sim/make-initdata.ts <bot_token> [user_id] [--no-signature]

   За замовчуванням у payload є поле signature: саме так шлють
   сучасні клієнти, і саме на ньому ламалась перевірка, поки його
   помилково викидали з рядка підпису. */

import { hmacSha256, toHex, utf8 } from '../src/rng';

const argv = process.argv.slice(2);
const token = argv[0];
const userId = Number(argv[1] || 4242);
const withSignature = !argv.includes('--no-signature');

if (!token) { console.error('потрібен токен бота'); process.exit(1); }

const fields: Record<string, string> = {
  auth_date: String(Math.floor(Date.now() / 1000)),
  chat_instance: '-1234567890123456789',
  chat_type: 'sender',
  query_id: 'AAHtest',
  user: JSON.stringify({
    id: userId,
    first_name: 'Перевірка',
    last_name: 'Тестова',
    username: 'checker',
    language_code: 'uk',
    allows_write_to_pm: true,
  }),
};
if (withSignature) fields.signature = 'Ed25519_signature_placeholder_from_telegram';

const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
const secret = hmacSha256(utf8('WebAppData'), utf8(token));
const hash = toHex(hmacSha256(secret, utf8(pairs.join('\n'))));

const qs = new URLSearchParams(fields);
qs.set('hash', hash);
process.stdout.write(qs.toString());
