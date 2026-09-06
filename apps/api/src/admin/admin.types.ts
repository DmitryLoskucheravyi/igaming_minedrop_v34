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

/** Активна сесія CRM. Живе в пам'яті процесу — рестарт API вимагає
    нового входу, і це навмисно: токени нікуди не витікають. */
export interface AdminSession {
  token: string;
  adminId: string;
  login: string;
  expiresAt: number;
}
