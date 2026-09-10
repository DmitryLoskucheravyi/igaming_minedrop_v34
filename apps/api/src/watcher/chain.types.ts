/* ============================================================
   ЧИТАЧ МЕРЕЖІ — рівно одна відповідальність: дістати перекази.

   Що з ними робити далі, читач не знає й знати не повинен. Рішення
   (яка це заявка, чи зараховувати, чи в неопізнані) живе в
   PaymentsService і вже покрите тестами без жодного ключа. Тут — лише
   HTTP до провайдера й переклад його відповіді в IncomingTx.

   Одиниця — РОДИНА, а не мережа: в EVM однакова подія переказу, тож
   один читач покриває шість мереж одним запитом.
   ============================================================ */

import type { Family, NetworkId, TokenId } from '../payments/networks';
import type { IncomingTx } from '../payments/payment.types';

export interface ScanContext {
  /** ключ до провайдера цієї родини */
  key: string;
  /** наша адреса-отримувач */
  address: string;
  /** мережі родини, увімкнені ПРОСТО ЗАРАЗ */
  networks: NetworkId[];
  /** монети, які приймаємо просто зараз */
  tokens: TokenId[];
  /** раніше цього моменту перекази не наші — це історія гаманця, мс */
  since: number;
  /** де читач зупинився минулого разу; формат — його власна справа */
  cursor?: string;
}

export interface ScanResult {
  /** знайдені перекази, від старіших до новіших */
  txs: IncomingTx[];
  /** новий курсор; undefined — лишити старий */
  cursor?: string;
}

/* Чи переказ усе ще в мережі, коли він уже мав відлежатись.

   Три відповіді, а не дві, і це принципово. 'gone' — мережа ПРЯМО
   каже, що переказу немає (відкат блока), і тільки тоді бот відхиляє
   заявку сам. 'unknown' — перепитати не вийшло: провайдер ліг, ключа
   немає, метод не підтримується. Плутати ці два випадки не можна:
   перший означає «грошей нема», другий — «ми не додзвонились», і
   відхиляти заявку через власні проблеми зі зв'язком не можна. */
export type Verdict = 'ok' | 'gone' | 'unknown';

export interface ChainReader {
  family: Family;
  /** хто саме віддає дані — видно в логах і в CRM */
  provider: string;
  scan(ctx: ScanContext): Promise<ScanResult>;
  confirm(key: string, network: NetworkId, txid: string): Promise<Verdict>;
}

/* ---- спільні дрібниці ---- */

/** HTTP із таймаутом. Без нього зависла відповідь стопорить весь цикл. */
export async function httpJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export const rpc = <T>(url: string, method: string, params: unknown, timeoutMs = 20_000) =>
  httpJson<{ result?: T; error?: { message?: string } }>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, timeoutMs);

/* Ціле в найменших одиницях -> число з комою.

   Через рядок і BigInt, а не діленням: у USDT з 18 знаками (BSC)
   сирове значення виходить за межі точного цілого в JS, і звичайне
   Number(raw)/1e18 почало б губити копійки саме там, де вони
   ідентифікують заявку. */
export function fromRaw(raw: string, decimals: number): number {
  const neg = raw.startsWith('-');
  const digits = (neg ? raw.slice(1) : raw).replace(/\D/g, '') || '0';
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = decimals ? padded.slice(padded.length - decimals) : '';
  return Number(`${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`);
}
