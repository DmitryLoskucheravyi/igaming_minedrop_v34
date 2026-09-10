/* ============================================================
   ФОРМАТУВАННЯ Й ПІДПИСИ — одні на гру й на CRM.

   До цього кожен файл писав своє. `rub()` існував у трьох копіях,
   `when()` — у трьох, причому у двох різних форматах (десь із роком,
   десь без). Статус `pending` перекладався як «ожидает», «ожидает
   оплаты» і «на рассмотрении» залежно від того, у якому вікні його
   показували. Це не варіанти — це розходження, яке ніхто не робив
   навмисно: просто копію правили в одному місці й не правили в решті.

   ПІДПИСИ АДМІНА ЛИШАЮТЬСЯ ОКРЕМО (app/admin/lib.ts). Це не той самий
   випадок: адмін і гравець дивляться на ту саму заявку з різних боків,
   і «отменена игроком» у гравця виглядало б безглуздо. Різні аудиторії —
   різні слова; однакова аудиторія — однакові.
   ============================================================ */

import type { PaymentStatus, WithdrawStatus } from '@minedrop/contracts';

/** Сума в ₽ без копійок, з розрядами: 12 500. */
export const rub = (n: number): string => Math.round(n).toLocaleString('ru-RU');

/** Дата й час без року: для свіжих записів, де рік і так зрозумілий. */
export const when = (ms: number): string =>
  new Date(ms).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Те саме з роком — для історії, де запис може бути й торішній. */
export const whenFull = (ms: number): string =>
  new Date(ms).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

/* ---- підписи статусів для ГРАВЦЯ ----
   Record<>, а не довільний об'єкт: додасться статус у контракт —
   TypeScript одразу покаже, що для нього немає перекладу. */

export const PAYMENT_STATUS_RU: Record<PaymentStatus, string> = {
  pending: 'ожидает оплаты',
  processing: 'перевод найден',
  approved: 'зачислено',
  rejected: 'отклонено',
  expired: 'истёк срок',
  canceled: 'отменено',
};

export const WITHDRAW_STATUS_RU: Record<WithdrawStatus, string> = {
  pending: 'на рассмотрении',
  approved: 'выплачено',
  rejected: 'отклонено',
  canceled: 'отменено',
};
