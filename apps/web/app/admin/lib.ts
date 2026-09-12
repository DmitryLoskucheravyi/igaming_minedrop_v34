/* Спільне для вкладок CRM.

   Доступ під адмін-логіном: POST /api/admin/login віддає токен сесії,
   він лежить у localStorage і йде в кожному запиті заголовком
   Authorization: Bearer. Саме заголовок, а не кука — тоді CSRF-поверхні
   немає взагалі (браузер сам такого заголовка не додасть).

   Токен протух або сесію скинули -> будь-який запит віддає 401. Тоді
   токен викидається, а сторінці шлеться подія, щоб вона показала форму
   входу замість напівживої таблиці. */

/* Форматування спільне з грою — див. src/lib/format. Перевипускаємо,
   щоб виклики в CRM лишились короткими (`rub`, `when`), а джерело було
   одне. Підписи статусів у CRM свої: адмін і гравець дивляться на ту
   саму заявку з різних боків. */
export { rub, when } from '../../src/lib/format';

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

/* Ідентифікатори й статуси описані в @minedrop/contracts — тими самими
   користуються сервер і гра. CRM їх не перелічує вдруге: три копії
   одного union-а вже розходились у перекладах. */
export type {
  Family, NetworkId, TokenId, DepositMode, UnmatchedStatus,
  PaymentStatus, ResolvedBy, WithdrawStatus,
} from '@minedrop/contracts';
import type {
  Family, TokenId, DepositMode, UnmatchedStatus,
  PaymentStatus, ResolvedBy, WithdrawStatus, Payment,
} from '@minedrop/contracts';

export interface CatalogueNetwork {
  id: string;
  name: string;
  family: Family;
  feeUsd: number;
  memo: boolean;
  tokens: TokenId[];
}

export interface DepositSettings {
  /** рубильник слушателя — отдельно от режима */
  enabled: boolean;
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

/* Заявка в CRM — це контрактна Payment плюс те, що потрібне лише
   адміну: підпис адреси з пулу й приєднаний гравець. Розширенням, а не
   копією: поле, додане в контракт, з'явиться тут само. */
export interface AdminPayment extends Payment {
  /** людський підпис адреси прийому, щоб не звіряти хеші очима */
  addressLabel: string | null;
  player: { firstName: string; username: string | null; balance: number } | null;
}

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

/* Промокод — надбавка к пополнению. used/granted нужны не для
   статистики ради статистики: по ним видно, что код утёк и его пора
   выключить, ещё до того как это станет заметно по балансу. */
export interface AdminPromo {
  id: string;
  code: string;
  /** сколько % от суммы пополнения уйдёт бонусом */
  percent: number;
  active: boolean;
  createdAt: number;
  /** сколько раз сработал на подтверждённой заявке */
  used: number;
  /** сколько всего ₽ выдано бонусом по этому коду */
  granted: number;
}

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
  processing: 'в обработке ботом',
  approved: 'зачислено',
  rejected: 'отклонено',
  expired: 'истёк',
  canceled: 'отменена игроком',
};

/* Кто именно закрыл заявку — приписка к статусу, а не отдельная
   колонка: важно это ровно в тот момент, когда смотришь на статус. */
export const statusLabel = (p: { status: PaymentStatus; resolvedBy?: ResolvedBy }): string =>
  (p.status === 'approved' || p.status === 'rejected') && p.resolvedBy
    ? `${STATUS_RU[p.status]} ${p.resolvedBy === 'bot' ? 'ботом' : 'админом'}`
    : STATUS_RU[p.status];

/* ---- слушатель ----

   Здоровье родины сетей: есть ли ключ, сколько адресов слушает, что
   сломалось в последнем цикле. Считается на сервере тем же кодом,
   который и ходит в сеть. */
export interface FamilyHealth {
  family: Family;
  provider: string;
  hasKey: boolean;
  addresses: number;
  lastRunAt?: number;
  lastOkAt?: number;
  lastError?: string;
  seen: number;
}

export interface WatcherStatus {
  /** не продакшн — в «Заявках» доступна кнопка симуляции перевода */
  dev: boolean;
  enabled: boolean;
  mode: DepositMode;
  running: boolean;
  pollMs: number;
  lastCycleAt?: number;
  credited: number;
  families: FamilyHealth[];
}
