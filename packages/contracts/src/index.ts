/* ============================================================
   КОНТРАКТИ — типи, які перетинають межу процесу.

   ЧОМУ ОКРЕМИЙ ПАКЕТ. Ті самі union-и були оголошені по три рази:
   на сервері (payments/*.types.ts), у грі (web/src/lib/api.ts) і в
   CRM (web/app/admin/lib.ts). Копії розійшлися рівно так, як і мали:
   `pending` перекладався як «ожидает», «ожидает оплаты» і «на
   рассмотрении» залежно від файлу, а додавання одного статусу
   `canceled` коштувало правок у шести місцях.

   Тут лежить ЛИШЕ те, про що сервер і клієнт домовились по дроту:
   ідентифікатори, статуси й форма записів, які реально їдуть у JSON.
   Серверні подробиці (курсор спостерігача, id адреси в пулі) лишаються
   на сервері й дописуються там окремими інтерфейсами; те, що потрібне
   тільки адмінці (приєднаний гравець, підпис адреси), — в CRM.

   Жодної логіки й жодних залежностей: пакет має лишатись описом, який
   можна імпортувати звідусіль, не тягнучи за собою рантайм.
   ============================================================ */

/* ---- мережі й монети ---- */

/* Родина, а не мережа: одна 0x-адреса приймає в усіх EVM-мережах
   одразу, тому й ключі до API, і адреси заводяться саме на родину. */
export type Family = 'evm' | 'tron' | 'ton' | 'solana';

export type NetworkId =
  | 'ton' | 'tron' | 'solana'
  | 'bsc' | 'polygon' | 'base' | 'arbitrum' | 'optimism' | 'avalanche';

export type TokenId = 'usdt' | 'usdc';

/* ---- заявки на поповнення ---- */

/* Метод лишився як рядок сумісності зі старими документами в базі.
   Тепер спосіб описують два поля: network + token. */
export type PaymentMethod = 'usdt_trc20' | 'crypto';

export type PaymentStatus =
  | 'pending'      // створена, чекаємо переказ + рішення адміна
  /* Бот знайшов переказ у мережі й тримає заявку, доки той не
     «відлежиться». Заявка в цьому стані НЕ ПРОТУХАЄ: тридцять хвилин
     відміряні на те, щоб людина встигла переказати. */
  | 'processing'
  | 'approved'     // підтверджено, баланс зараховано
  | 'rejected'     // відхилено (ким — у resolvedBy)
  | 'expired'      // 30 хв минуло без переказу
  | 'canceled';    // гравець зняв сам, ще не переказавши

/* Хто закрив заявку. Різниця не косметична: розбираючи скаргу, треба
   бачити, це рішення людини чи бота. */
export type ResolvedBy = 'admin' | 'bot';

/** Заявка на поповнення так, як її бачить клієнт. */
export interface Payment {
  id: string;
  telegramId: number;
  method: PaymentMethod;
  network: NetworkId;
  token: TokenId;
  /** скільки нарахувати на баланс, ₽ */
  amount: number;
  /** скільки переказати в токені (за курсом на момент створення) */
  usdtAmount: number;
  /** код у коментар переказу — тільки в мережах, які їх підтримують */
  memo?: string;
  /** курс ₽/USDT, зафіксований при створенні */
  rate: number;
  /** курс був приблизний (біржа не відповідала) — сума може не збігатися
      з ринковою, і це видно і гравцю, і адміну */
  rateApprox?: boolean;
  address: string;
  status: PaymentStatus;
  resolvedBy?: ResolvedBy;
  createdAt: number;
  expiresAt: number;
  resolvedAt?: number;
  /** ідентифікатор переказу в мережі (його ж захист від подвійного
      зарахування: один переказ не закриває дві заявки) */
  txid?: string;
  /** скільки НАСПРАВДІ прийшло, у токені */
  paidAmount?: number;
  /** коли переказ знайдено в мережі */
  matchedAt?: number;
  /** раніше цього моменту переказ не вважається остаточним */
  confirmAt?: number;
  /** коли мережа визнала переказ остаточним */
  confirmedAt?: number;
  adminNote?: string;
}

/** Мережа, доступна для поповнення просто зараз. */
export interface DepositNetwork {
  id: NetworkId;
  name: string;
  /** приблизна комісія відправника, $ — головний аргумент вибору */
  feeUsd: number;
  /** переказ ідентифікується коментарем, а не сумою */
  memo: boolean;
  tokens: TokenId[];
}

/** Відповідь /payments/me. */
export interface PaymentsInfo {
  active: Payment | null;
  history: Payment[];
  minRub: number;
  maxRub: number;
  /** курс ₽/USDT просто зараз — щоб оцінити суму ДО створення заявки */
  rate: number;
  rateApprox: boolean;
  /* Час СЕРВЕРА на момент відповіді. Таймер заявки — це expiresAt мінус
     «зараз», і на збитому годиннику телефону він брехав би на години. */
  now: number;
  networks: DepositNetwork[];
}

/* ---- виведення ---- */

export type WithdrawMethod = 'usdt_trc20';

export type WithdrawStatus =
  | 'pending'    // чекає рішення адміна, гроші вже зарезервовані
  | 'approved'   // адмін відправив кошти
  | 'rejected'   // адмін відхилив, гроші повернуто
  | 'canceled';  // гравець скасував сам, гроші повернуто

export interface Withdraw {
  id: string;
  telegramId: number;
  method: WithdrawMethod;
  /** скільки списано з балансу, ₽ */
  amount: number;
  /** скільки відправити гравцю, USDT */
  usdtAmount: number;
  rate: number;
  rateApprox?: boolean;
  address: string;
  status: WithdrawStatus;
  createdAt: number;
  resolvedAt?: number;
  adminNote?: string;
}

export interface WithdrawInfo {
  active: Withdraw | null;
  history: Withdraw[];
  minRub: number;
  maxRub: number;
}

/* ---- неопізнані перекази ---- */

export type UnmatchedStatus = 'new' | 'credited' | 'ignored';

/* ---- налаштування прийому ---- */

/* off — не слухаємо; watch — тільки показуємо знахідки; semi — бот
   готує, зараховує адмін; auto — бот зараховує сам. */
export type DepositMode = 'off' | 'watch' | 'semi' | 'auto';
