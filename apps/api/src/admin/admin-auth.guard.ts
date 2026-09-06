import {
  CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { AdminsService } from './admins.service';
import type { AdminSession } from './admin.types';

/* ============================================================
   Гард CRM.

   Клієнт шле заголовок:
       Authorization: Bearer <токен сесії>

   Токен видає POST /api/admin/login. Заголовок, а не кука —
   свідомо: тоді CSRF-поверхні немає взагалі (браузер не додає
   заголовок сам), і не треба ні парсера кук, ні SameSite-танців.

   Раніше на цьому місці стояла перевірка «не продакшн» — тобто в
   деві CRM була відкрита всім, хто знає адресу. А адресу знали:
   `npm run tg` друкує {тунель}/admin у консоль, і тунель публічний.
   Будь-хто міг поповнити собі баланс і побачити telegram id усіх
   гравців.
   ============================================================ */

export interface AdminRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  admin?: AdminSession;
}

export const bearerFrom = (headers: AdminRequest['headers']): string | null => {
  const raw = headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const m = /^bearer\s+(.+)$/i.exec((header ?? '').trim());
  return m ? m[1].trim() : null;
};

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly admins: AdminsService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const token = bearerFrom(req.headers);
    if (!token) throw new UnauthorizedException('Нужен вход в админку');

    const session = this.admins.session(token);
    if (!session) throw new UnauthorizedException('Сессия истекла — войди заново');

    req.admin = session;
    return true;
  }
}

/** Сесія адміна з перевіреного токена */
export const CurrentAdmin = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AdminSession => {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    if (!req.admin) throw new UnauthorizedException('Запрос не прошёл гард админки');
    return req.admin;
  },
);
