import {
  CanActivate, ExecutionContext, Inject, Injectable, Logger, UnauthorizedException,
} from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { initDataFromHeader, verifyInitData, type TelegramUser } from './init-data';

/* ============================================================
   Гард авторизації мініапса.

   Клієнт шле заголовок:
       Authorization: tma <Telegram.WebApp.initData>

   Гард перевіряє підпис ботовим токеном і кладе користувача в
   req.tgUser. Далі контролери працюють уже з довіреним telegram id.

   DEV-РЕЖИМ
   Якщо токена немає і це не прод — приймається заголовок
   x-dev-user: <число>. Це потрібно, щоб гра відкривалась у
   звичайному браузері й щоб ганявся sim:e2e. У проді така гілка
   недосяжна: loadEnv() не дасть стартувати без токена.
   ============================================================ */

export interface RequestWithUser {
  headers: Record<string, string | string[] | undefined>;
  tgUser?: TelegramUser;
}

const header = (req: RequestWithUser, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

@Injectable()
export class TelegramAuthGuard implements CanActivate {
  private readonly log = new Logger(TelegramAuthGuard.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RequestWithUser>();

    const initData = initDataFromHeader(header(req, 'authorization'));

    /* Dev-режим НЕ означає «пускати будь-кого».

       Якщо клієнт прислав initData і токен у нас є — перевіряємо
       по-справжньому. Інакше підроблений підпис мовчки ставав би
       dev-гравцем, і локальний прогін показував би зелене там, де
       в проді буде 401.

       На x-dev-user падаємо тільки коли заголовка немає зовсім —
       тобто гру відкрили у звичайному браузері. */
    if (this.env.devAuth && !(initData && this.env.botToken)) {
      const raw = header(req, 'x-dev-user') ?? '1';
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) {
        throw new UnauthorizedException('x-dev-user має бути додатним цілим');
      }
      req.tgUser = { id, firstName: 'dev-' + id, username: 'dev' + id };
      return true;
    }

    if (!initData) {
      throw new UnauthorizedException('Немає заголовка Authorization: tma <initData>');
    }

    const res = verifyInitData(initData, this.env.botToken!, this.env.initDataMaxAgeSec);
    if (!res.ok) {
      /* Логуємо СКЛАД полів, а не значення: у них телеграм-id, імʼя
         та фото гравця. Для розбору причини вистачає назв — саме так
         і знайшлось, що клієнти шлють signature. */
      let fields = '?';
      try { fields = [...new URLSearchParams(initData).keys()].sort().join(','); } catch { /* ignore */ }
      this.log.warn(`initData відхилено: ${res.reason} | поля: ${fields}`);
      throw new UnauthorizedException('Підпис телеграма не пройшов перевірку');
    }

    req.tgUser = res.user;
    return true;
  }
}

/** Довірений користувач із перевіреного initData */
export const TgUser = createParamDecorator((_: unknown, ctx: ExecutionContext): TelegramUser => {
  const req = ctx.switchToHttp().getRequest<RequestWithUser>();
  if (!req.tgUser) throw new UnauthorizedException('Запит не пройшов гард авторизації');
  return req.tgUser;
});
