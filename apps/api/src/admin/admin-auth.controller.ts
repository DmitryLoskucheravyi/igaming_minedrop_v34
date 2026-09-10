import {
  Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post, Req, UseGuards,
} from '@nestjs/common';
import { RateLimiter, clientKey } from '../common/rate-limit';
import { AdminsService } from './admins.service';
import { AdminAuthGuard, CurrentAdmin, bearerFrom, type AdminRequest } from './admin-auth.guard';
import type { AdminSession } from './admin.types';
import { LoginDto, RefreshDto } from './admin.dto';

/* ============================================================
   ВХІД У CRM.

   Єдині два публічні маршрути всього застосунку адміна — вхід і обмін
   refresh. Решта CRM закрита гардом, і тримати їх в одному файлі з
   рештою означало б щоразу перечитувати, які саме маршрути відкриті.
   Тут це видно з першого рядка.

   Було: єдиною перепоною стояло `if (isProd) throw` — тобто поза
   продом CRM була відкрита будь-кому, хто знає адресу, включно з
   публічним тунелем із `npm run tg`.
   ============================================================ */

/* Обмін токенів відкритий назовні, тому має свій ліміт. 60 на хвилину —
   з великим запасом для живого клієнта (він міняє раз на 15 хвилин) і
   мало для перебору. REFRESH_GLOBAL — той самий спільний рубіж, що й
   LOGIN_GLOBAL/VERIFY_GLOBAL: per-ключовий лічильник довіряє clientKey,
   а це останній рівень страховки на випадок, якщо довіра до проксі
   колись стане іншою. */
const REFRESH_LIMIT = new RateLimiter(60, 60_000);
const REFRESH_GLOBAL = new RateLimiter(300, 60_000);

@Controller('admin')
export class AdminAuthController {
  constructor(private readonly admins: AdminsService) {}

  /** Єдиний маршрут CRM без токена. Лічильник спроб — в AdminsService. */
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: AdminRequest) {
    return this.admins.login(dto.login, dto.password, clientKey(req.headers, req.ip));
  }

  /* Обмін refresh на нову пару. Публічний, як і вхід: access тут за
     побудовою вже протух, тож гардом його не перевіриш. Ліміт частоти
     обов'язковий — маршрут відкритий. */
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() req: AdminRequest) {
    const key = clientKey(req.headers, req.ip);
    if (!REFRESH_LIMIT.take(key) || !REFRESH_GLOBAL.take('all')) {
      throw new HttpException(
        `Слишком часто. Попробуй через ${REFRESH_LIMIT.retryAfterSec(key)} с`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.admins.refresh(dto.refresh);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  logout(@Req() req: AdminRequest) {
    const token = bearerFrom(req.headers);
    if (token) this.admins.logout(token);
    return { ok: true };
  }

  /** Хто зайшов + до якого часу жива сесія. Фронт кличе на старті,
      щоб зрозуміти, показувати форму входу чи вже саму CRM. */
  @Get('me')
  @UseGuards(AdminAuthGuard)
  me(@CurrentAdmin() session: AdminSession) {
    return { admin: this.admins.view(session.adminId), expiresAt: session.expiresAt };
  }
}
