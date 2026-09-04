/* ============================================================
   FAIRNESS — commit-reveal, щоб гравець міг перевірити раунд.

   Як це працює:
     1. Сервер придумує serverSeed (32 байти) і ПУБЛІКУЄ лише
        sha256(serverSeed) — це «зобов'язання». Змінити сид після
        цього він уже не може, не змінивши хеш.
     2. Гравець дає свій clientSeed (будь-який рядок) — тому сервер
        не може підібрати serverSeed під конкретного гравця.
     3. Сид раунду = HMAC-SHA256(serverSeed, "clientSeed:nonce").
        nonce росте на кожному раунді.
     4. Коли гравець просить — сервер РОЗКРИВАЄ serverSeed і бере новий.
        Тепер будь-який минулий раунд перераховується локально:
        хеш зійшовся -> сид справжній -> resolveRound() дає ту саму виплату.

   Весь цей файл однаково працює в браузері, тому «перевірити» —
   не обіцянка, а кнопка, яка реально рахує.
   ============================================================ */

import { fromHex, hmacSha256, sha256, toHex, utf8 } from './rng';

export function serverSeedHash(serverSeedHex: string): string {
  return toHex(sha256(fromHex(serverSeedHex)));
}

export function roundSeed(serverSeedHex: string, clientSeed: string, nonce: number): string {
  return toHex(hmacSha256(fromHex(serverSeedHex), utf8(`${clientSeed}:${nonce}`)));
}

/** Чи справді розкритий serverSeed відповідає опублікованому хешу */
export function verifyCommit(serverSeedHex: string, publishedHash: string): boolean {
  return serverSeedHash(serverSeedHex).toLowerCase() === publishedHash.toLowerCase();
}
