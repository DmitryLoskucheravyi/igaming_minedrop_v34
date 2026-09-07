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
export const UNAUTHORIZED_EVENT = 'minedrop:admin-unauthorized';

export function getToken(): string | null {
  try { return window.localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* приватний режим — сесія проживе до перезавантаження */ }
}

export class AdminApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
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
    if (res.status === 401) {
      setToken(null);
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
