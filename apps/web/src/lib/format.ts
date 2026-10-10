/* ============================================================
   ФОРМАТУВАННЯ — одне на гру й на CRM.

   До цього кожен файл писав своє, і копії розходились: десь дата з
   роком, десь без. Тут одне джерело.
   ============================================================ */

/** Ціле з розрядами: 12 500. */
export const num = (n: number): string => Math.round(n).toLocaleString('ru-RU');

/** Дата й час без року: для свіжих записів, де рік і так зрозумілий. */
export const when = (ms: number): string =>
  new Date(ms).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Те саме з роком — для історії, де запис може бути й торішній. */
export const whenFull = (ms: number): string =>
  new Date(ms).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Скільки лишилось до моменту: «5 ч 12 мин» / «12 мин» / «меньше минуты». */
export const left = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(m / 60);
  if (h > 0) return `${h} ч ${m % 60} мин`;
  if (m > 0) return `${m} мин`;
  return 'меньше минуты';
};
