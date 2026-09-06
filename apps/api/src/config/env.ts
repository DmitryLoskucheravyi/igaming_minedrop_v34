/* ============================================================
   ENV — усі змінні оточення в одному місці, з перевіркою на старті.

   Головне правило: у проді без TELEGRAM_BOT_TOKEN сервер НЕ
   стартує. Без токена немає чим перевірити initData, а без цього
   будь-хто надішле чужий telegram id і забере чужий баланс.
   У dev токена може не бути — тоді вмикається явний dev-режим
   із гучним попередженням у лог.
   ============================================================ */

export interface Env {
  port: number;
  isProd: boolean;

  /** Токен від @BotFather. У проді обов'язковий. */
  botToken: string | null;

  /** https-адреса мініапса — з неї бот робить кнопку запуску */
  webAppUrl: string | null;

  /** Скільки секунд initData вважається свіжим (захист від переграшу) */
  initDataMaxAgeSec: number;

  /** Дозволені origin для CORS. Порожньо = same-origin, CORS не потрібен */
  webOrigins: string[];

  /** Прод: приймати апдейти вебхуком замість полінгу */
  webhookUrl: string | null;
  webhookSecret: string | null;

  /** dev-режим авторизації: приймати заголовок x-dev-user замість initData */
  devAuth: boolean;

  /** MongoDB для персистентності гравців. Порожньо — тільки in-memory
      (стан гине з рестартом). */
  mongoUrl: string | null;
}

/* Коли можна пускати без підпису телеграма.

   Токен потрібен боту, але щойно він з'являється, гра у звичайному
   браузері починає віддавати 401 — а налагоджувати все через телефон
   незручно. Тому є явний перемикач DEV_AUTH=true.

   Він завжди помножений на !isProd, тобто у продакшні недосяжний
   за побудовою: скільки б DEV_AUTH там не стояло, авторизація
   лишиться справжньою. */
function resolveDevAuth(isProd: boolean, botToken: string | null): boolean {
  if (isProd) return false;
  return !botToken || process.env.DEV_AUTH === 'true';
}

export function loadEnv(): Env {
  const isProd = process.env.NODE_ENV === 'production';
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;

  if (isProd && !botToken) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN не заданий. У продакшні без нього не можна: ' +
      'initData нічим перевірити, і будь-хто зможе видати себе за іншого гравця.',
    );
  }

  return {
    port: Number(process.env.PORT ?? 4000),
    isProd,
    botToken,
    webAppUrl: process.env.WEBAPP_URL?.trim() || null,
    initDataMaxAgeSec: Number(process.env.INITDATA_MAX_AGE ?? 24 * 60 * 60),
    webOrigins: (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
      .split(',').map((s) => s.trim()).filter(Boolean),
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL?.trim() || null,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || null,
    devAuth: resolveDevAuth(isProd, botToken),
    mongoUrl: process.env.MONGO_URL?.trim() || null,
  };
}

export const ENV = 'ENV';
