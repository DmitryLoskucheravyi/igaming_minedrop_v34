/* ============================================================
   ADMIN — обліковий запис для CRM.

   Живе в окремій колекції `admins` (в термінах SQL — окрема
   таблиця): гравці й адміни це різні сутності з різними ключами,
   і змішувати їх в одному сховищі не можна навіть тимчасово.

   Пароль у БД НЕ зберігається. Лежить лише scrypt-хеш і випадкова
   сіль на кожен запис: витік дампа бази не дає ані пароля, ані
   можливості порівняти хеші двох адмінів між собою.
   ============================================================ */

export interface AdminRecord {
  /** внутрішній id (uuid), _id документа в Mongo */
  id: string;
  /** логін для входу — унікальний, зберігається в нижньому регістрі */
  login: string;
  email: string;
  /** scrypt(пароль, salt) у hex */
  passwordHash: string;
  /** випадкова сіль у hex, своя на кожен запис */
  passwordSalt: string;
  createdAt: number;
  lastLoginAt?: number;
}

/** Те, що можна віддати назовні: без хеша й солі. */
export interface AdminView {
  id: string;
  login: string;
  email: string;
  lastLoginAt?: number;
}

export const adminView = (a: AdminRecord): AdminView => ({
  id: a.id,
  login: a.login,
  email: a.email,
  lastLoginAt: a.lastLoginAt,
});

/* ---- ПАРА ТОКЕНІВ ----
   access — короткий, іде в КОЖНОМУ запиті. Живе хвилини, тому вкрадений
     дає зловмиснику вузьке вікно.
   refresh — довгий, іде ЛИШЕ в один маршрут (/admin/refresh) і тільки
     щоб обміняти себе на нову пару.

   familyId зв'язує їх у «родину»: усі пари, що виросли з одного входу,
   мають спільний id. Це дає дві речі — вихід гасить сесію цілком, а
   повторне використання вже витраченого refresh (ознака того, що його
   хтось перехопив) гасить усю родину, а не лише цей токен. */
export interface AdminSession {
  token: string;
  adminId: string;
  login: string;
  familyId: string;
  expiresAt: number;
}

export interface AdminRefresh {
  token: string;
  adminId: string;
  login: string;
  familyId: string;
  expiresAt: number;
  /** коли його вже обміняли. Другий обмін тим самим токеном — тривога */
  usedAt?: number;
}

/** Те, що віддаємо клієнту при вході й при обміні. */
export interface Tokens {
  token: string;            // access
  expiresAt: number;
  refresh: string;
  refreshExpiresAt: number;
}
