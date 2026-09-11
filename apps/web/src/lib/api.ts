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
  /** подаровані колесом прокрути, які ще не зіграні */
  freeSpins: number;
  pityAt: number;
  clientSeed: string;
  serverSeedHash: string;
  nonce: number;
  config?: PublicConfig;
}

/* КОЛЕСО ЩОДЕННОГО БОНУСУ.
   Сектори приходять із сервера — своєї копії списку клієнт не тримає,
   інакше картинка й математика розійшлись би при першій же зміні. */
export interface WheelState {
  ready: boolean;
  /** коли можна буде крутити (мс epoch); null — можна вже зараз */
  nextAt: number | null;
  /** час сервера: годинник на телефоні буває збитий на години */
  now: number;
  /** перший прокрут акаунта — приз гарантований */
  first: boolean;
  freeSpins: number;
  /** ставка, на якій зіграють подаровані прокрути (число задає сервер) */
  freeBet: number;
  prizes: { id: string; label: string }[];
}

export interface WheelSpin {
  prize: { id: string; rub: number; spins: number; label: string };
  /** НОМЕР СЕКТОРА, на якому має зупинитись колесо. Саме він, а не
      приз: однакових призів на колесі буває кілька. */
  index: number;
  state: WheelState;
  balance: number;
}

/* РЕФЕРАЛЬНИЙ КАБІНЕТ. link може бути null: ім'я бота приїжджає з
   getMe при старті сервера, і до цього моменту зібрати посилання нема
   з чого — тоді показуємо сам код. */
export interface ReferralFriend {
  telegramId: number;
  name: string;
  at: number;
  /** коли друг добив поріг депозиту (null — ще ні) */
  depositedAt: number | null;
  /** скільки вже вніс депозитами, ₽ */
  deposited: number;
  earned: number;
}

export interface ReferralState {
  code: string;
  link: string | null;
  webAppUrl: string | null;
  joinRub: number;
  depositRub: number;
  /** з якої суми депозитів друга платиться друга виплата */
  depositMin: number;
  earned: number;
  friends: ReferralFriend[];
}

export interface RevealedSeries {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  rounds: number;
}

/* Форма всього, що їде по дроту, описана в @minedrop/contracts —
   одним джерелом на сервер, гру й CRM. Тут лише перевипуск, щоб решта
   клієнта імпортувала типи звідти ж, звідки й функції запитів. */
export type {
  Family, NetworkId, TokenId,
  Payment, PaymentMethod, PaymentStatus, PaymentsInfo, DepositNetwork, ResolvedBy,
  Withdraw, WithdrawInfo, WithdrawMethod, WithdrawStatus,
} from '@minedrop/contracts';
import type { NetworkId, TokenId, Payment, PaymentsInfo, Withdraw, WithdrawInfo } from '@minedrop/contracts';


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

  /** Реферальний кабінет: посилання, друзі, заробіток. */
  referrals() {
    return call<ReferralState>('/referrals/me');
  },

  /** Стан колеса: чи можна крутити, коли наступний, які сектори. */
  wheel() {
    return call<WheelState>('/wheel');
  },

  /** Крутнути колесо. Приз визначає СЕРВЕР — анімація на клієнті лише
      доводить стрілку до вже відомого сектора. */
  spinWheel() {
    return call<WheelSpin>('/wheel/spin', { method: 'POST' });
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
