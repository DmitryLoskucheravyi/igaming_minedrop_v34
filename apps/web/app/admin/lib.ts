/* Спільне для вкладок CRM.

   Доступ під адмін-логіном: POST /api/admin/login віддає токен сесії,
   він лежить у localStorage і йде в кожному запиті заголовком
   Authorization: Bearer. Саме заголовок, а не кука — тоді CSRF-поверхні
   немає взагалі (браузер сам такого заголовка не додасть).

   Токен протух або сесію скинули -> будь-який запит віддає 401. Тоді
   токен викидається, а сторінці шлеться подія, щоб вона показала форму
   входу замість напівживої таблиці. */

export const rub = (n: number) => Math.round(n).toLocaleString('ru-RU');

export const when = (ms: number) =>
  new Date(ms).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const TOKEN_KEY = 'minedrop.adminToken';
const REFRESH_KEY = 'minedrop.adminRefresh';
export const UNAUTHORIZED_EVENT = 'minedrop:admin-unauthorized';

export interface Tokens {
  token: string;
  expiresAt: number;
  refresh: string;
  refreshExpiresAt: number;
}

const read = (k: string): string | null => {
  try { return window.localStorage.getItem(k); } catch { return null; }
};
const write = (k: string, v: string | null): void => {
  try {
    if (v) window.localStorage.setItem(k, v);
    else window.localStorage.removeItem(k);
  } catch { /* приватний режим — сесія проживе до перезавантаження */ }
};

export const getToken = () => read(TOKEN_KEY);
export const getRefresh = () => read(REFRESH_KEY);

/** Зберегти пару. null очищає обидва — це і є вихід. */
export function setTokens(t: Tokens | null): void {
  write(TOKEN_KEY, t?.token ?? null);
  write(REFRESH_KEY, t?.refresh ?? null);
}

/* Обмін протухлого access на нову пару.

   Проміс СПІЛЬНИЙ на всі запити: сторінка легко робить три запити
   одночасно, усі три отримають 401 в один момент, і без цього кожен
   пішов би міняти токен сам. А обмін ротаційний — другий такий запит
   прийшов би вже з витраченим refresh, і сервер справедливо вирішив би,
   що токен украли, та скинув би сесію повністю. */
let refreshing: Promise<boolean> | null = null;

function refreshTokens(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refresh = getRefresh();
    if (!refresh) return false;
    try {
      const res = await fetch('/api/admin/refresh', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh }),
      });
      if (!res.ok) return false;
      setTokens(await res.json() as Tokens);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export class AdminApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export async function api<T>(path: string, init?: RequestInit, allowRetry = true): Promise<T> {
  const token = getToken();
  const res = await fetch('/api/admin' + path, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    /* access живе хвилини, тому 401 — це очікуваний стан, а не поломка.
       Пробуємо обміняти refresh і повторити запит РІВНО ОДИН раз: якщо
       не вийшло, сесії справді немає. init тут перевикористовується
       безпечно — тіло завжди рядок, а не потік. */
    if (res.status === 401 && allowRetry && getRefresh()) {
      if (await refreshTokens()) return api<T>(path, init, false);
    }
    if (res.status === 401) {
      setTokens(null);
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const body = await res.json().catch(() => ({}));
    const msg = (body as { message?: string | string[] }).message;
    throw new AdminApiError(
      msg ? ([] as string[]).concat(msg).join('; ') : `HTTP ${res.status}`,
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

export interface AdminMe {
  id: string;
  login: string;
  email: string;
  lastLoginAt?: number;
}

export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface AdminPayment {
  id: string;
  telegramId: number;
  amount: number;
  usdtAmount: number;
  rate: number;
  /** курс на момент створення був приблизний — сума USDT може не
      збігатися з ринковою, перед підтвердженням варто звірити */
  rateApprox?: boolean;
  address: string;
  addressId?: string;
  addressLabel: string | null;
  status: PaymentStatus;
  createdAt: number;
  expiresAt: number;
  adminNote?: string;
  player: { firstName: string; username: string | null; balance: number } | null;
}

export type WithdrawStatus = 'pending' | 'approved' | 'rejected' | 'canceled';

export interface AdminWithdraw {
  id: string;
  telegramId: number;
  amount: number;        // ₽, уже списані з балансу гравця
  usdtAmount: number;
  rate: number;
  rateApprox?: boolean;
  address: string;       // адреса ГРАВЦЯ — саме сюди слати
  status: WithdrawStatus;
  createdAt: number;
  resolvedAt?: number;
  adminNote?: string;
  player: { firstName: string; username: string | null; balance: number } | null;
}

export const WITHDRAW_STATUS_RU: Record<WithdrawStatus, string> = {
  pending: 'ожидает',
  approved: 'выплачено',
  rejected: 'отклонено',
  canceled: 'отменено',
};

export interface AdminAddress {
  id: string;
  address: string;
  label?: string;
  active: boolean;
  createdAt: number;
  pending: number;
}

export const STATUS_RU: Record<PaymentStatus, string> = {
  pending: 'ожидает',
  approved: 'зачислено',
  rejected: 'отклонено',
  expired: 'истёк',
};
