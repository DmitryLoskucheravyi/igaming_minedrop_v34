/* Спільне для вкладок адмінки. CRM без авторизації (dev-only), тому
   просто fetch на /api/admin/*. */

export const rub = (n: number) => Math.round(n).toLocaleString('ru-RU');

export const when = (ms: number) =>
  new Date(ms).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api/admin' + path, {
    cache: 'no-store',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string | string[] }).message
      ? ([] as string[]).concat((body as { message: string | string[] }).message).join('; ')
      : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface AdminPayment {
  id: string;
  telegramId: number;
  amount: number;
  usdtAmount: number;
  address: string;
  addressId?: string;
  addressLabel: string | null;
  status: PaymentStatus;
  createdAt: number;
  expiresAt: number;
  adminNote?: string;
  player: { firstName: string; username: string | null; balance: number } | null;
}

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
