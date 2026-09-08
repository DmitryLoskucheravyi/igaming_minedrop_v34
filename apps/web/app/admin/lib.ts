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

/* Мережі описані на сервері (payments/networks.ts) і приходять
   каталогом. CRM їх не перелічує: додану мережу видно тут одразу,
   без правок фронта. */
export type Family = 'evm' | 'tron' | 'ton' | 'solana';
export type TokenId = 'usdt' | 'usdc';

export interface CatalogueNetwork {
  id: string;
  name: string;
  family: Family;
  feeUsd: number;
  memo: boolean;
  tokens: TokenId[];
}

/* Режим прийому. Довіряти боту нарахування одразу — погана ідея, тому
   станів чотири, а не «увімк/вимк»: спершу дивишся, що він БУВ БИ
   зробив, потім даєш йому позначати, і лише потім — платити. */
export type DepositMode = 'off' | 'watch' | 'semi' | 'auto';

export interface DepositSettings {
  mode: DepositMode;
  networks: string[];
  tokens: TokenId[];
}

export interface DepositCatalogue {
  networks: CatalogueNetwork[];
  tokens: { id: TokenId; name: string }[];
  familyHints: Record<Family, string>;
}

/* Что наблюдатель слушает прямо сейчас. Считается на сервере из
   текущих адресов и текущих настроек, поэтому в CRM видно не пересказ
   намерения, а буквально его рабочий список. */
export interface WatchTarget {
  addressId: string;
  address: string;
  family: Family;
  label?: string;
  watchFrom: number;
  cursor?: string;
  scannedAt?: number;
  networks: string[];
  tokens: TokenId[];
}

export type UnmatchedStatus = 'new' | 'credited' | 'ignored';

/** Переказ прийшов, але не зіставився з жодною заявкою. */
export interface AdminUnmatched {
  id: string;
  network: string;
  networkName: string;
  token: TokenId;
  address: string;
  from: string;
  amount: number;
  txid: string;
  at: number;
  memo?: string;
  status: UnmatchedStatus;
  seenAt: number;
  resolvedAt?: number;
  creditedTo?: number;
  creditedRub?: number;
  adminNote?: string;
  player: string | null;
}

export interface AdminPayment {
  id: string;
  telegramId: number;
  network: string;
  token: TokenId;
  amount: number;
  usdtAmount: number;
  memo?: string;
  /** проставляє спостерігач, коли знаходить переказ у мережі */
  txid?: string;
  paidAmount?: number;
  matchedAt?: number;
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
  /** с какого момента наблюдатель смотрит эту адресу */
  watchFrom?: number;
  /** когда её в последний раз просматривали */
  scannedAt?: number;
  /* Родина, а не мережа: одна 0x-адреса приймає в усіх EVM-мережах
     одразу, тож заводити її шість разів безглуздо. */
  family: Family;
  label?: string;
  active: boolean;
  createdAt: number;
  pending: number;
}

export const FAMILY_RU: Record<Family, string> = {
  evm: 'EVM (0x…)',
  tron: 'TRON',
  ton: 'TON',
  solana: 'Solana',
};

export const MODE_RU: Record<DepositMode, { name: string; note: string }> = {
  off: { name: 'Выключен', note: 'бот не слушает сеть вообще' },
  watch: { name: 'Наблюдение', note: 'видит переводы и пишет в лог, но ничего не трогает' },
  semi: { name: 'Полуавтомат', note: 'сам находит перевод и помечает заявку оплаченной, зачисляешь ты' },
  auto: { name: 'Автомат', note: 'зачисляет сам, без твоего участия' },
};

export const UNMATCHED_RU: Record<UnmatchedStatus, string> = {
  new: 'разобрать',
  credited: 'зачислено',
  ignored: 'оставлено',
};

export const STATUS_RU: Record<PaymentStatus, string> = {
  pending: 'ожидает',
  approved: 'зачислено',
  rejected: 'отклонено',
  expired: 'истёк',
};
