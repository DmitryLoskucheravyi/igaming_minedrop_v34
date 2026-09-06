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

  /** Адреса гаманця USDT TRC20 для депозитів. Порожньо — депозит вимкнено. */
  usdtTrc20Address: string | null;

  /* ---- CRM ----
     Обліковий запис адміна засівається в колекцію `admins` при старті.
     Пароль у БД лежить хешем (scrypt + сіль), у .env — відкритим:
     .env і є те місце, звідки береться перший пароль. Порожній
     adminPassword = адміна не завести, вхід у CRM неможливий. */
  adminLogin: string | null;
  adminEmail: string | null;
  adminPassword: string | null;
  /** Скільки годин живе сесія CRM */
  adminSessionTtlH: number;
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

  /* .env.example давно обіцяв, що в проді MONGO_URL обов'язковий, але
     ніхто цього не перевіряв: із порожнім рядком сервер спокійно
     піднімався «в пам'яті» й мовчки втрачав усіх гравців при кожному
     рестарті. Падати на старті тут набагато краще, ніж дізнатися про
     це після першого деплою. */
  const mongoUrl = process.env.MONGO_URL?.trim() || null;
  if (isProd && !mongoUrl) {
    throw new Error(
      'MONGO_URL не заданий. У продакшні без бази не можна: ' +
      'баланси, заявки й адміни живуть лише в пам\'яті процесу і гинуть із рестартом.',
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
    mongoUrl,
    usdtTrc20Address: process.env.USDT_TRC20_ADDRESS?.trim() || null,
    adminLogin: process.env.ADMIN_LOGIN?.trim() || null,
    adminEmail: process.env.ADMIN_EMAIL?.trim() || null,
    // пароль не тримаємо: у ньому можуть бути значущі пробіли по краях
    adminPassword: process.env.ADMIN_PASSWORD || null,
    adminSessionTtlH: Number(process.env.ADMIN_SESSION_TTL_H ?? 12),
  };
}

export const ENV = 'ENV';
