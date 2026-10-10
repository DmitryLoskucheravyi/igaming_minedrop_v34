/* ============================================================
   КОІНИ — єдина валюта гри.

   Сервер рахує в коінах, клієнт показує в коінах; курсів і перемикача
   валют більше немає. Значок малюється окремою іконкою (canvas і DOM),
   тому форматувальники повертають ЧИСТЕ число рядком, без символу.
   ============================================================ */

/** Код для мапи значків на канвасі ('cur.<код>' в Assets). */
export const COIN = 'COIN';
export const COIN_ICON = '/coins/coin.svg';

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Дрібна сума (виграш за блок, живий лог): до двох знаків, щоб
    виграш у долі коіна не перетворювався на «0». */
export function fmtAmount(n: number): string {
  if (Math.abs(n) >= 100 || Number.isInteger(n)) return String(Math.round(n));
  return trimZeros(n.toFixed(Math.abs(n) < 1 ? 2 : 1));
}

/** Велика сума (баланс, ставка, виплата): ціле. */
export function fmtWhole(n: number): string {
  return String(Math.round(n));
}

/** Ціле з розрядами для DOM: 12 500. На канвасі розрядів немає —
    растровий шрифт пробілу не знає. */
export function fmtCoins(n: number): string {
  return Math.round(n).toLocaleString('ru-RU');
}
