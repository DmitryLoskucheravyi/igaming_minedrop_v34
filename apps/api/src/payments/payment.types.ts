/* ============================================================
   PAYMENTS — заявки на депозит.

   Потік:
     1. гравець створює заявку (сума в ₽, метод usdt_trc20);
     2. отримує адресу гаманця + точну суму USDT + таймер 30 хв;
        більше нічого не тисне;
     3. переказує USDT ззовні;
     4. адмін бачить заявку в CRM, звіряє транзакцію в мережі,
        погоджує (approved -> баланс зараховано) або скасовує (rejected);
     5. якщо за PAYMENT_TTL_MS підтвердження немає — заявка стає expired.
   ============================================================ */

export type PaymentMethod = 'usdt_trc20';

export type PaymentStatus =
  | 'pending'    // створена, чекаємо переказ + рішення адміна
  | 'approved'   // адмін підтвердив, баланс зараховано
  | 'rejected'   // адмін відхилив
  | 'expired';   // 30 хв минуло без підтвердження

/* Гаманець-приймач. Адрес кілька, адмін керує ними в CRM. Кожну
   заявку прив'язуємо до однієї адреси (по можливості вільної), щоб
   адмін розрізняв, за яку саме заявку прийшли кошти. */
export interface DepositAddress {
  id: string;
  address: string;
  /** заголовок для адмінки, щоб не плутати адреси */
  label?: string;
  active: boolean;
  createdAt: number;
}

export interface PaymentRecord {
  id: string;
  telegramId: number;
  method: PaymentMethod;

  /** скільки нарахувати на баланс, ₽ */
  amount: number;
  /** скільки переказати, USDT (за курсом на момент створення) */
  usdtAmount: number;
  /** курс ₽/USDT, зафіксований при створенні */
  rate: number;
  /** адреса гаманця, куди переказувати (копія рядка на момент створення) */
  address: string;
  /** id адреси з пулу (може вже не існувати, якщо адмін її видалив) */
  addressId?: string;

  status: PaymentStatus;
  createdAt: number;
  /** createdAt + PAYMENT_TTL_MS */
  expiresAt: number;
  /** коли адмін погодив/скасував або коли протухла */
  resolvedAt?: number;
  /** нотатка адміна при скасуванні (необов'язково) */
  adminNote?: string;
}

/** Публічний зріз для клієнта/CRM (усе, крім нічого — тут секретів нема). */
export type PaymentView = PaymentRecord;

export const PAYMENT_TTL_MS = 30 * 60 * 1000;   // 30 хв
export const PAYMENT_MIN_RUB = 100;
export const PAYMENT_MAX_RUB = 5_000_000;
