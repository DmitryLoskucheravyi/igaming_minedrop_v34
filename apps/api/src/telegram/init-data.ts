/* ============================================================
   INIT DATA — перевірка підпису телеграма.

   Мініапс отримує від клієнта рядок Telegram.WebApp.initData —
   звичайний query string, підписаний ботовим токеном. Перевірка:

     data_check_string = усі поля, КРІМ hash і signature,
                         відсортовані за ключем, склеєні через \n
                         у вигляді "key=value"
     secret_key        = HMAC_SHA256(key="WebAppData", data=<bot_token>)
     очікуваний hash   = hex(HMAC_SHA256(key=secret_key, data=data_check_string))

   Це єдине, що відрізняє справжнього гравця від будь-кого, хто
   надіслав чужий telegram id руками. Тому:
     - порівняння часу-стійке (timingSafeEqual);
     - auth_date перевіряється на свіжість, інакше один раз
       перехоплений initData працював би вічно.

   HMAC беремо з рушія — там він уже написаний і покритий тестами,
   нової залежності не треба.
   ============================================================ */

import { hmacSha256, toHex, utf8 } from '@minedrop/engine';
import { timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
  photoUrl?: string;
}

export type InitDataResult =
  /* startParam — те, що телеграм кладе в initData із посилання
     t.me/<bot>?start=<code> (або /app?startapp=<code>). Беремо його
     САМЕ ЗВІДСИ, а не з тіла запиту: рядок підписаний ботовим токеном
     разом з усім іншим, тож приписати собі чужий код підміною запиту
     не вийде. Реферальна прив'язка тримається на ньому. */
  | { ok: true; user: TelegramUser; authDate: number; startParam?: string }
  | { ok: false; reason: string };

/* Поля, які не входять у рядок перевірки.

   ТІЛЬКИ hash. Поле signature (Ed25519, Bot API 8.0+) сучасні
   клієнти шлють разом із hash, і воно Є ЧАСТИНОЮ того, що
   підписано ботовим токеном.

   Це не дрібниця: доки signature викидали, справжній initData із
   телеграма не проходив узагалі — «підпис не збігся» на кожному
   відкритті мініапса. Згенерований у тестах проходив, бо в ньому
   поля signature просто не було.

   Викидати signature треба в ІНШОМУ методі — коли перевіряють
   не ботовим токеном, а публічним ключем телеграма. Тут не той
   випадок. */
const SKIP = new Set(['hash']);

export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSec: number,
): InitDataResult {
  if (!initData) return { ok: false, reason: 'initData порожній' };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'initData не розбирається як query string' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'у initData немає hash' };
  if (!/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'hash не схожий на sha256' };

  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (!SKIP.has(k)) pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secret = hmacSha256(utf8('WebAppData'), utf8(botToken));
  const expected = toHex(hmacSha256(secret, utf8(dataCheckString)));

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash.toLowerCase(), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'підпис не збігся' };
  }

  /* Свіжість. Без цього перехоплений initData був би вічним ключем. */
  const authDate = Number(params.get('auth_date') ?? 0);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: 'немає auth_date' };
  }
  const ageSec = Math.floor(Date.now() / 1000) - authDate;
  if (ageSec > maxAgeSec) {
    return { ok: false, reason: `initData протух (${ageSec}с при ліміті ${maxAgeSec}с)` };
  }

  const rawUser = params.get('user');
  if (!rawUser) return { ok: false, reason: 'у initData немає user' };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawUser) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'user не розбирається як JSON' };
  }

  const id = Number(parsed.id);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'некоректний user.id' };

  const startParam = params.get('start_param') ?? undefined;

  return {
    ok: true,
    authDate,
    startParam,
    user: {
      id,
      firstName: String(parsed.first_name ?? ''),
      lastName: parsed.last_name ? String(parsed.last_name) : undefined,
      username: parsed.username ? String(parsed.username) : undefined,
      languageCode: parsed.language_code ? String(parsed.language_code) : undefined,
      isPremium: parsed.is_premium === true,
      photoUrl: parsed.photo_url ? String(parsed.photo_url) : undefined,
    },
  };
}

/** Витягти initData із заголовка Authorization: tma <initData> */
export function initDataFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^tma\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
