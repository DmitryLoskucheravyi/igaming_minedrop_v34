/* ============================================================
   API — тонкий клієнт до NestJS.

   Особу підтверджує телеграм: у кожен запит іде заголовок
       Authorization: tma <Telegram.WebApp.initData>
   Сервер перевіряє підпис ботовим токеном. Ніякого «свого» id
   клієнт більше не вигадує — підмінити гравця не можна.

   Поза телеграмом (звичайний браузер, налагодження) шлеться
   x-dev-user. Сервер приймає його ТІЛЬКИ якщо в нього не задано
   TELEGRAM_BOT_TOKEN і це не продакшн.
   ============================================================ */

import type { RoundResult, TierId } from '@minedrop/engine';
import { devUserId, initData } from './telegram';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export interface PublicConfig {
  bets: number[];
  spinsPerBet: number;
  payoutK: number;
  maxWinX: number;
  /** множник ціни бонус баю на кожну кірку (ціна = ставка * множник) */
  buyPrices: Record<string, number>;
  /** курс для косметичного перерахунку балансу в USDT / зірки */
  rates: { rubPerUsdt: number; rubPerStar: number; updatedAt: number };
}

export interface PlayerState {
  telegramId: number;
  firstName: string;
  username: string | null;
  balance: number;
  /** пустих ставок поспіль ОКРЕМО по кожній ставці (ключ — номінал ставки);
      коли лічильник ставки досягає pityAt, наступний прокрут на НІЙ
      гарантовано дає кірку */
  dryStreaks: Record<number, number>;
  /* Виграна скаттерами, ще не зіграна бонуска — разом зі ставкою, на
     якій її виграли. Наступний звичайний прокрут піде саме нею і саме
     на цій ставці. null — немає. */
  pendingBonus: { bet: number } | null;
  pityAt: number;
  clientSeed: string;
  serverSeedHash: string;
  nonce: number;
  config?: PublicConfig;
}

export interface RevealedSeries {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  rounds: number;
}

/* processing — перевод найден в сети и «отлёживается» до окончательного
   подтверждения. Заявка в этом состоянии НЕ истекает: деньги уже
   отправлены, и таймер к ним отношения не имеет. */
export type PaymentStatus =
  'pending' | 'processing' | 'approved' | 'rejected' | 'expired' | 'canceled';

/* Мережі й токени описані на сервері (payments/networks.ts). Клієнт їх
   не перелічує: список увімкнених міняється в CRM на ходу й приходить
   у PaymentsInfo. Тут лишаються тільки рядкові типи. */
export type NetworkId = string;
export type TokenId = 'usdt' | 'usdc';

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

export interface Payment {
  id: string;
  telegramId: number;
  method: string;
  /** у якій мережі й яким токеном платить гравець */
  network: NetworkId;
  token: TokenId;
  amount: number;        // ₽ на баланс
  usdtAmount: number;    // скільки переказати
  /** код у коментар переказу — тільки в мережах, які їх підтримують */
  memo?: string;
  rate: number;
  /** курс на момент створення був приблизний (біржа не відповідала) —
      сума USDT може не збігатися з ринковою, це треба показати */
  rateApprox?: boolean;
  address: string;
  status: PaymentStatus;
  createdAt: number;
  expiresAt: number;
  /** сколько на самом деле пришло, в токене */
  paidAmount?: number;
  /** раньше этого момента перевод ещё не считается окончательным */
  confirmAt?: number;
  /** сеть признала перевод окончательным */
  confirmedAt?: number;
  resolvedAt?: number;
  adminNote?: string;
}

export interface PaymentsInfo {
  active: Payment | null;
  history: Payment[];
  minRub: number;
  maxRub: number;
  /** курс ₽/USDT просто зараз — для оцінки суми ДО створення заявки */
  rate: number;
  /** курс приблизний (біржа не відповіла) */
  rateApprox: boolean;
  /** час сервера на момент відповіді — поправка до годинника телефону */
  now: number;
  /** що зараз увімкнено адміном — саме це показуємо у виборі */
  networks: DepositNetwork[];
}

/* ---- виведення коштів ----
   Дзеркало депозиту, але баланс списується В МОМЕНТ ЗАЯВКИ, а не при
   погодженні. Тому кожна операція тут міняє баланс просто зараз. */
export type WithdrawStatus = 'pending' | 'approved' | 'rejected' | 'canceled';

export interface Withdraw {
  id: string;
  telegramId: number;
  method: 'usdt_trc20';
  amount: number;        // ₽ списано з балансу
  usdtAmount: number;    // скільки відправлять
  rate: number;
  rateApprox?: boolean;
  address: string;       // адреса ГРАВЦЯ, куди слати
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

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function authHeaders(): Record<string, string> {
  const data = initData();
  if (data) return { Authorization: `tma ${data}` };
  return { 'x-dev-user': String(devUserId()) };
}

/* Без цього таймауту запит, обірваний згортанням мініапса (телеграм
   призупиняє мережу у фоні), просто висів би вічно — fetch() ніколи
   не резолвиться й не відхиляється сам. Presenter.startRound() уже
   вміє одну повторну спробу й показ помилки при мережевому збої, але
   без явного обриву тут той код узагалі не спрацьовує: чекає вічно,
   а кнопка лишається disabled. */
const REQUEST_TIMEOUT_MS = 15000;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(init?.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      const m = (body as { message?: string | string[] }).message;
      if (m) msg = Array.isArray(m) ? m.join('; ') : m;
    } catch { /* тіло не JSON — лишаємо код */ }
    throw new ApiError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

const newKey = () =>
  (globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(36).slice(2));

export const Api = {
  /** Стан гравця. Перший виклик заводить його на сервері. */
  me() {
    return call<PlayerState>('/players/me');
  },

  /* Ключ ідемпотентності: у вебв'ю телеграма запит може обірватись і
     піти повторно. Без ключа це друга списана ставка. */
  /** buy — купити гарантовану кірку (бонус бай). Ціну рахує сервер. */
  play(bet: number, key = newKey(), buy?: TierId) {
    return call<{ round: RoundResult; player: PlayerState }>('/rounds/play', {
      method: 'POST',
      headers: { 'x-idempotency-key': key },
      body: JSON.stringify(buy ? { bet, mode: 'buy', buy } : { bet, mode: 'bet' }),
    });
  },

  setClientSeed(clientSeed: string) {
    return call<PlayerState>('/players/me/client-seed', {
      method: 'POST',
      body: JSON.stringify({ clientSeed }),
    });
  },

  fairness() {
    return call<{
      current: { serverSeedHash: string; clientSeed: string; nonce: number };
      revealed: RevealedSeries[];
    }>('/fairness/me');
  },

  rotate() {
    return call<{ revealed: RevealedSeries; next: { serverSeedHash: string; nonce: number } }>(
      '/fairness/rotate', { method: 'POST' });
  },

  /** Історія платежів + активна заявка. */
  payments() {
    return call<PaymentsInfo>('/payments/me');
  },

  /** Створити заявку на депозит (₽). Повертає заявку з адресою й таймером. */
  /** зняти власну заявку, поки переказу ще немає */
  cancelPayment(id: string) {
    return call<Payment>(`/payments/${id}/cancel`, { method: 'POST' });
  },

  createPayment(amount: number, network: NetworkId, token: TokenId) {
    return call<Payment>('/payments', {
      method: 'POST',
      body: JSON.stringify({ amount, network, token }),
    });
  },

  /** Історія виводів + активна заявка. */
  withdrawals() {
    return call<WithdrawInfo>('/withdrawals/me');
  },

  /** Заявка на вивід. Баланс списується одразу, тому у відповіді
      приходить і свіжий стан гравця. */
  createWithdraw(amount: number, address: string) {
    return call<{ withdraw: Withdraw; player: PlayerState }>('/withdrawals', {
      method: 'POST',
      body: JSON.stringify({ amount, address, method: 'usdt_trc20' }),
    });
  },

  /** Скасувати власну заявку — гроші повертаються на баланс. */
  cancelWithdraw(id: string) {
    return call<{ withdraw: Withdraw; player: PlayerState }>(`/withdrawals/${id}/cancel`, {
      method: 'POST',
    });
  },
};
