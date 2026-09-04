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

import type { RoundMode, RoundResult } from '@minedrop/engine';
import { devUserId, initData } from './telegram';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export interface PublicConfig {
  bets: number[];
  spinsPerBet: number;
  bonusSpins: number;
  buyCost: number;
  streak: number;
  payoutK: number;
  maxWinX: number;
}

export interface PlayerState {
  telegramId: number;
  firstName: string;
  username: string | null;
  balance: number;
  streak: number;
  streakNeeded: number;
  bonusPending: boolean;
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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });

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
  play(bet: number, mode: RoundMode, key = newKey()) {
    return call<{ round: RoundResult; player: PlayerState }>('/rounds/play', {
      method: 'POST',
      headers: { 'x-idempotency-key': key },
      body: JSON.stringify({ bet, mode }),
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
};
