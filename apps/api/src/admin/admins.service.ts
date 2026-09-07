import {
  HttpException, HttpStatus, Inject, Injectable, Logger,
  UnauthorizedException, type OnModuleInit,
} from '@nestjs/common';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { ENV, type Env } from '../config/env';
import { MongoService } from '../db/mongo.service';
import { RateLimiter } from '../common/rate-limit';
import { AdminStore } from './admin-store';
import {
  adminView, type AdminRecord, type AdminRefresh, type AdminSession, type AdminView,
  type Tokens,
} from './admin.types';

/* ============================================================
   ADMINS — облікові записи CRM і сесії до неї.

   ПАРОЛЬ. У БД лягає лише scrypt(пароль, сіль): сіль випадкова на
   кожен запис, порівняння — timingSafeEqual, щоб час відповіді не
   підказував, скільки символів збіглося.

   ЗВІДКИ БЕРЕТЬСЯ ПЕРШИЙ АДМІН. З .env (ADMIN_LOGIN / ADMIN_EMAIL /
   ADMIN_PASSWORD). На старті:
     - логіна нема в базі -> заводимо;
     - є, але пароль у .env від нього не підходить -> перезаписуємо
       хеш і пошту (тобто .env — джерело правди для скидання пароля).
   Порожній ADMIN_PASSWORD означає «адміна не заводити»: у CRM тоді
   просто нема з чим увійти. Це безпечний дефолт — жодного пароля
   за замовчуванням у коді немає.

   СЕСІЇ. Пара непрозорих токенів (по 32 випадкові байти) у пам'яті
   процесу. Рестарт API = повторний вхід; це навмисно, токени ніде не
   зберігаються, отже й витекти з бази не можуть.

   access живе ACCESS_TTL і йде в кожному запиті. refresh живе
   ADMIN_SESSION_TTL_H годин і приймається ЛИШЕ на /admin/refresh.
   Обмін РОТАЦІЙНИЙ: кожен refresh одноразовий, натомість видається
   нова пара. Якщо той самий refresh приходить удруге — це означає, що
   копія токена в когось іще, тому гаситься вся родина, а не тільки
   цей токен.

   ПЕРЕБІР. scrypt свідомо повільний (десятки мс), тому сам по собі
   він і є вузьким місцем при переборі — але ним же можна забити
   процесор. Тому лічильник спроб стоїть ПЕРЕД хешуванням.
   ============================================================ */

const SCRYPT_KEYLEN = 64;

/* 8 спроб на 15 хвилин: людині, яка забула пароль, вистачає,
   перебору — ні. Ключ — логін + адреса, щоб один клієнт не міг
   заблокувати чужий акаунт, просто довбаючи його логін. */
const LOGIN_ATTEMPTS = new RateLimiter(8, 15 * 60_000);

/* Час життя access-токена. Коротко настільки, щоб вкрадений швидко
   протух, і достатньо, щоб не смикати обмін на кожній дії. */
const ACCESS_TTL_MS = 15 * 60_000;

function hashPassword(password: string, salt: string): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN);
}

@Injectable()
export class AdminsService implements OnModuleInit {
  private readonly log = new Logger(AdminsService.name);
  private readonly admins = new Map<string, AdminRecord>();     // id -> запис
  private readonly sessions = new Map<string, AdminSession>();  // access -> сесія
  private readonly refreshes = new Map<string, AdminRefresh>(); // refresh -> запис
  private store: AdminStore | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mongo: MongoService,
  ) {}

  async onModuleInit(): Promise<void> {
    const db = await this.mongo.ready();
    if (db) {
      const store = new AdminStore(db);
      await store.ensureIndexes();
      for (const a of await store.loadAll()) this.admins.set(a.id, a);
      this.store = store;
    }
    await this.seedFromEnv();
  }

  /* ---- засів адміна з .env ---- */

  private async seedFromEnv(): Promise<void> {
    const { adminLogin, adminEmail, adminPassword } = this.env;

    if (!adminLogin || !adminPassword) {
      this.log.warn(
        'ADMIN_LOGIN / ADMIN_PASSWORD не задані — жодного адміна не заведено, ' +
        'у CRM увійти неможливо. Заповни їх у .env.',
      );
      return;
    }

    const login = adminLogin.toLowerCase();
    const found = this.byLogin(login);

    if (!found) {
      const salt = randomBytes(16).toString('hex');
      const rec: AdminRecord = {
        id: randomUUID(),
        login,
        email: adminEmail ?? '',
        passwordSalt: salt,
        passwordHash: hashPassword(adminPassword, salt).toString('hex'),
        createdAt: Date.now(),
      };
      this.admins.set(rec.id, rec);
      await this.persist(rec);
      this.log.log(`Заведено адміна CRM: ${rec.login}`);
      return;
    }

    /* Логін уже є. Якщо пароль із .env до нього не підходить — його
       там змінили навмисно (скидання), тому перезаписуємо. Якщо
       підходить — не чіпаємо нічого, щоб не смітити записами в БД. */
    if (!this.passwordOk(found, adminPassword)) {
      const salt = randomBytes(16).toString('hex');
      found.passwordSalt = salt;
      found.passwordHash = hashPassword(adminPassword, salt).toString('hex');
      found.email = adminEmail ?? found.email;
      await this.persist(found);
      this.dropSessionsOf(found.id);
      this.log.warn(`Пароль адміна ${found.login} оновлено з .env; активні сесії скинуто.`);
    } else if (adminEmail && found.email !== adminEmail) {
      found.email = adminEmail;
      await this.persist(found);
    }
  }

  private async persist(rec: AdminRecord): Promise<void> {
    try {
      await this.store?.save(rec);
    } catch (e) {
      this.log.error(`не зберігся адмін ${rec.login}: ${(e as Error).message}`);
    }
  }

  private byLogin(login: string): AdminRecord | undefined {
    const needle = login.toLowerCase();
    for (const a of this.admins.values()) if (a.login === needle) return a;
    return undefined;
  }

  private passwordOk(rec: AdminRecord, password: string): boolean {
    const expected = Buffer.from(rec.passwordHash, 'hex');
    if (!expected.length) return false;
    const got = hashPassword(password, rec.passwordSalt);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /* ---- вхід / вихід ---- */

  /** Логін у CRM. Кидає 401 при невірних даних, 429 при переборі. */
  login(loginRaw: string, password: string, from: string): Tokens & { admin: AdminView } {
    const login = loginRaw.trim().toLowerCase();
    const key = `${login}|${from}`;

    if (!LOGIN_ATTEMPTS.take(key)) {
      throw new HttpException(
        `Слишком много попыток. Повтори через ${LOGIN_ATTEMPTS.retryAfterSec(key)} с`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const rec = this.byLogin(login);
    /* Однакова відповідь і на неіснуючий логін, і на невірний пароль —
       інакше форма входу перетворюється на перевірку, чи існує логін. */
    if (!rec || !this.passwordOk(rec, password)) {
      this.log.warn(`невдалий вхід у CRM: ${login} (${from})`);
      throw new UnauthorizedException('Неверный логин или пароль');
    }

    LOGIN_ATTEMPTS.reset(key);
    rec.lastLoginAt = Date.now();
    void this.persist(rec);
    this.log.log(`вхід у CRM: ${rec.login} (${from})`);

    return { ...this.issuePair(rec), admin: adminView(rec) };
  }

  /** Обміняти refresh на нову пару. Старий після цього недійсний. */
  refresh(token: string): Tokens {
    this.sweep();
    const rec = this.refreshes.get(token);
    if (!rec) throw new UnauthorizedException('Сессия истекла — войди заново');

    /* Токен уже витрачали. Легальний клієнт так не робить: він щоразу
       зберігає новий. Отже копія в чужих руках — гасимо всю родину,
       щоб і зловмисник, і справжній власник пішли логінитись наново. */
    if (rec.usedAt) {
      this.dropFamily(rec.familyId);
      this.log.warn(`повторне використання refresh (${rec.login}) — сесію скинуто повністю`);
      throw new UnauthorizedException('Сессия сброшена из соображений безопасности');
    }
    if (rec.expiresAt <= Date.now()) {
      this.refreshes.delete(token);
      throw new UnauthorizedException('Сессия истекла — войди заново');
    }

    const admin = this.admins.get(rec.adminId);
    if (!admin) {
      this.dropFamily(rec.familyId);
      throw new UnauthorizedException('Аккаунт больше не существует');
    }

    rec.usedAt = Date.now();
    // старий access тієї ж родини теж більше не потрібен
    for (const [t, sess] of this.sessions) {
      if (sess.familyId === rec.familyId) this.sessions.delete(t);
    }
    return this.issuePair(admin, rec.familyId);
  }

  /** Вихід гасить сесію ЦІЛКОМ: і access, і всі refresh тієї ж родини.
      Інакше після «виходу» лишався б живий refresh, яким можна було б
      відновити доступ. */
  logout(token: string): void {
    const sess = this.sessions.get(token);
    if (sess) this.dropFamily(sess.familyId);
    else this.sessions.delete(token);
  }

  /* Явний тип у familyId навмисно: без нього TypeScript виводить із
     randomUUID() літеральний шаблон `${string}-${string}-...`, і в цей
     параметр не можна передати звичайний рядок із наявної родини. */
  private issuePair(rec: AdminRecord, familyId: string = randomUUID()): Tokens {
    const now = Date.now();
    const refreshTtl = Math.max(1, this.env.adminSessionTtlH) * 60 * 60 * 1000;

    const access: AdminSession = {
      token: randomBytes(32).toString('hex'),
      adminId: rec.id, login: rec.login, familyId,
      expiresAt: now + ACCESS_TTL_MS,
    };
    const refresh: AdminRefresh = {
      token: randomBytes(32).toString('hex'),
      adminId: rec.id, login: rec.login, familyId,
      expiresAt: now + refreshTtl,
    };
    this.sessions.set(access.token, access);
    this.refreshes.set(refresh.token, refresh);

    return {
      token: access.token,
      expiresAt: access.expiresAt,
      refresh: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  private dropFamily(familyId: string): void {
    for (const [t, s] of this.sessions) if (s.familyId === familyId) this.sessions.delete(t);
    for (const [t, r] of this.refreshes) if (r.familyId === familyId) this.refreshes.delete(t);
  }

  /* Витрачені refresh тримаємо до їхнього ж строку — саме вони й
     ловлять повторне використання. Далі викидаємо. */
  private sweep(): void {
    const now = Date.now();
    for (const [t, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(t);
    for (const [t, r] of this.refreshes) if (r.expiresAt <= now) this.refreshes.delete(t);
  }

  /** Жива сесія за токеном або null. Побіжно чистить протухлі. */
  session(token: string): AdminSession | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  view(adminId: string): AdminView | null {
    const rec = this.admins.get(adminId);
    return rec ? adminView(rec) : null;
  }

  private dropSessionsOf(adminId: string): void {
    for (const [token, s] of this.sessions) if (s.adminId === adminId) this.sessions.delete(token);
  }
}
