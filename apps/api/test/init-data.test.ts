/* ============================================================
   Тест перевірки initData.

   Це найважливіший код у всьому API: він один відрізняє
   справжнього гравця від того, хто просто написав чужий
   telegram id у запиті. Тому перевіряємо не тільки «валідне
   проходить», а й кожен спосіб підробки.

   npm run test:auth -w @minedrop/api
   ============================================================ */

import { hmacSha256, toHex, utf8 } from '@minedrop/engine';
import { initDataFromHeader, verifyInitData } from '../src/telegram/init-data';

const TOKEN = '123456:AAHfakeTokenForTestsOnly_not_a_real_bot';
const MAX_AGE = 3600;

let bad = 0;
const check = (cond: boolean, name: string) => {
  if (cond) console.log('  ok  ', name);
  else { console.log('  FAIL', name); bad++; }
};

/** Зібрати підписаний initData так, як це робить телеграм */
function makeInitData(fields: Record<string, string>, token = TOKEN): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = hmacSha256(utf8('WebAppData'), utf8(token));
  const hash = toHex(hmacSha256(secret, utf8(pairs.join('\n'))));

  const qs = new URLSearchParams(fields);
  qs.set('hash', hash);
  return qs.toString();
}

const now = () => Math.floor(Date.now() / 1000);
const user = (id: number) => JSON.stringify({ id, first_name: 'Тест', username: 'tester' });

const base = () => ({ auth_date: String(now()), query_id: 'AAE', user: user(777) });

console.log('initData:');

/* 1. Валідний підпис проходить, і user розбирається */
{
  const res = verifyInitData(makeInitData(base()), TOKEN, MAX_AGE);
  check(res.ok, 'валідний initData приймається');
  check(res.ok && res.user.id === 777, 'user.id читається правильно');
  check(res.ok && res.user.firstName === 'Тест', 'кирилиця в імені не б\'ється');
}

/* 2. Підміна будь-якого поля ламає підпис */
{
  const good = makeInitData(base());
  const p = new URLSearchParams(good);
  p.set('user', user(999));                    // хочемо чужий акаунт
  const res = verifyInitData(p.toString(), TOKEN, MAX_AGE);
  check(!res.ok, 'підміна user.id відхиляється');
}

/* 3. Чужий токен не підходить */
{
  const foreign = makeInitData(base(), '999999:someOtherBotToken');
  const res = verifyInitData(foreign, TOKEN, MAX_AGE);
  check(!res.ok, 'initData, підписаний іншим ботом, відхиляється');
}

/* 4. Без hash — нема розмови */
{
  const p = new URLSearchParams(makeInitData(base()));
  p.delete('hash');
  check(!verifyInitData(p.toString(), TOKEN, MAX_AGE).ok, 'initData без hash відхиляється');
}

/* 5. Протухлий auth_date. Інакше один раз перехоплений initData
      був би вічним ключем до акаунта. */
{
  const old = makeInitData({ ...base(), auth_date: String(now() - MAX_AGE - 60) });
  const res = verifyInitData(old, TOKEN, MAX_AGE);
  check(!res.ok, 'протухлий initData відхиляється');
  check(!res.ok && res.reason.includes('протух'), 'причина відмови — саме вік');
}

/* 6. Свіжий, але близько до межі — має пройти */
{
  const nearly = makeInitData({ ...base(), auth_date: String(now() - MAX_AGE + 60) });
  check(verifyInitData(nearly, TOKEN, MAX_AGE).ok, 'initData у межах строку приймається');
}

/* 7. Поле signature (Ed25519, Bot API 8.0+).

      Сучасні клієнти шлють його разом із hash, і воно ВХОДИТЬ у те,
      що підписано ботовим токеном. Саме на цьому все й ламалось:
      поки signature викидали з рядка перевірки, справжній initData
      із телеграма не проходив жодного разу, а тести були зелені —
      бо в них цього поля просто не було.

      Тому перевіряємо обидва випадки: із ним і без нього. */
{
  const withSig = makeInitData({ ...base(), signature: 'Ed25519_signature_from_telegram' });
  check(verifyInitData(withSig, TOKEN, MAX_AGE).ok,
    'initData ІЗ signature приймається (як шле справжній телеграм)');

  const withoutSig = makeInitData(base());
  check(verifyInitData(withoutSig, TOKEN, MAX_AGE).ok,
    'initData БЕЗ signature теж приймається (старі клієнти)');

  // раз signature підписаний — його підміна має ламати перевірку
  const p = new URLSearchParams(withSig);
  p.set('signature', 'підмінено');
  check(!verifyInitData(p.toString(), TOKEN, MAX_AGE).ok,
    'підміна signature відхиляється');
}

/* 8. Порожнє й сміття */
{
  check(!verifyInitData('', TOKEN, MAX_AGE).ok, 'порожній initData відхиляється');
  check(!verifyInitData('%%%', TOKEN, MAX_AGE).ok, 'сміття відхиляється');
  check(!verifyInitData('hash=zz', TOKEN, MAX_AGE).ok, 'нешістнадцятковий hash відхиляється');
}

/* 9. Немає user — нема кого пускати */
{
  const noUser = makeInitData({ auth_date: String(now()), query_id: 'AAE' });
  check(!verifyInitData(noUser, TOKEN, MAX_AGE).ok, 'initData без user відхиляється');
}

console.log('\nзаголовок Authorization:');
check(initDataFromHeader('tma abc=1') === 'abc=1', 'tma <data> розбирається');
check(initDataFromHeader('TMA  abc=1') === 'abc=1', 'регістр і пробіли не заважають');
check(initDataFromHeader('Bearer abc') === null, 'Bearer не приймається');
check(initDataFromHeader(undefined) === null, 'відсутній заголовок дає null');

console.log(bad === 0 ? '\nAUTH OK — підробки відхиляються' : `\n${bad} failures`);
process.exit(bad ? 1 : 0);
