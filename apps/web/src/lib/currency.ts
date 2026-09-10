/* ============================================================
   CURRENCY — валюта ВІДОБРАЖЕННЯ.

   Уся математика гри й баланс на сервері — у «рублях» (базова
   одиниця). Тут лише косметика: ті самі числа можна показати в
   USDT або в зірках телеграма. Вибір гравця живе в localStorage,
   курс приходить із сервера в config.rates (оновлюється раз на добу).

   Значок валюти малюється окремою іконкою (canvas і DOM), тому
   форматувальники повертають ЧИСТЕ число рядком, без символу.
   ============================================================ */

export type CurrencyCode = 'RUB' | 'USDT' | 'XTR';

export interface Rates {
  rubPerUsdt: number;
  rubPerStar: number;
  updatedAt: number;
}

/* Поки config не приїхав або курс нульовий. */
export const FALLBACK_RATES: Rates = { rubPerUsdt: 100, rubPerStar: 2.8, updatedAt: 0 };

export const CURRENCIES: readonly CurrencyCode[] = ['RUB', 'USDT', 'XTR'];

export interface CurrencyMeta {
  icon: string;
  /** одноколірний силует (чорний) — тонується у колір тексту */
  mono: boolean;
  label: string;
  decimals: number;
}

export const CURRENCY_META: Record<CurrencyCode, CurrencyMeta> = {
  RUB:  { icon: '/coins/rub.png',   mono: true,  label: 'Рубли',  decimals: 2 },
  USDT: { icon: '/coins/usdt.png',  mono: false, label: 'USDT',   decimals: 2 },
  // зірки цілі — дробові «89.3 ⭐» виглядають зламано
  XTR:  { icon: '/coins/xtr.png', mono: false, label: 'Звёзды', decimals: 0 },
};

const STORAGE_KEY = 'minedrop.currency';

export function loadCurrency(): CurrencyCode {
  if (typeof window === 'undefined') return 'RUB';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'RUB' || v === 'USDT' || v === 'XTR') return v;
  } catch { /* приватний режим — просто дефолт */ }
  return 'RUB';
}

export function saveCurrency(c: CurrencyCode): void {
  try { window.localStorage.setItem(STORAGE_KEY, c); } catch { /* ignore */ }
}

function rate(cur: CurrencyCode, rates: Rates): number {
  if (cur === 'USDT') return rates.rubPerUsdt || FALLBACK_RATES.rubPerUsdt;
  if (cur === 'XTR')  return rates.rubPerStar || FALLBACK_RATES.rubPerStar;
  return 1;
}

/** Рублі -> число у вибраній валюті. */
export function convert(rub: number, cur: CurrencyCode, rates: Rates): number {
  return rub / rate(cur, rates);
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Дрібна сума (виграш за блок, живий лог): показуємо достатньо знаків,
    щоб у USDT/зірках не виходило «0». */
export function fmtAmount(rub: number, cur: CurrencyCode, rates: Rates): string {
  const v = convert(rub, cur, rates);
  const d = CURRENCY_META[cur].decimals;
  const dec = v !== 0 && Math.abs(v) < 1 / 10 ** d ? d + 2 : d;
  return trimZeros(v.toFixed(dec));
}

/** Велика сума (баланс, ставка, виплата): у рублях — ціле,
    в інших валютах — до decimals знаків. */
export function fmtWhole(rub: number, cur: CurrencyCode, rates: Rates): string {
  const v = convert(rub, cur, rates);
  if (cur === 'RUB') return String(Math.round(v));
  return trimZeros(v.toFixed(CURRENCY_META[cur].decimals));
}
