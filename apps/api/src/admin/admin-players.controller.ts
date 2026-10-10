import {
  Body, Controller, Get, NotFoundException, Param, Post, UseGuards,
} from '@nestjs/common';
import { PlayersService } from '../players/players.service';
import { AdminAuthGuard, CurrentAdmin } from './admin-auth.guard';
import type { AdminSession } from './admin.types';
import { TopUpDto } from './admin.dto';

/* ============================================================
   ВКЛАДКА «ИГРОКИ» — баланси коінів і необоротні дії над ними.

   Три різні дії з коінами, і кожна навмисно окрема: нарахувати,
   обнулити, видалити гравця. Обнулення й видалення не мають вигляду
   «поповнення з іншим числом», бо повернути їх нічим.
   ============================================================ */

@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminPlayersController {
  constructor(private readonly players: PlayersService) {}

  /** Усі гравці, свіжіші зверху. */
  @Get('players')
  list() {
    const players = this.players.all()
      .sort((a, b) => b.seenAt - a.seenAt)
      .map((r) => ({
        telegramId: r.telegramId,
        firstName: r.firstName,
        username: r.username ?? null,
        balance: this.players.balance(r),
        /* Серія заходів: день, забраний востаннє, і коли. Видно, хто
           повертається щодня, а хто зайшов раз. */
        streak: r.streak ?? 0,
        dailyDay: r.dailyDay ?? null,
        nonce: r.nonce,
        // найдовша серія до гарантії серед усіх ставок гравця
        dryStreak: Math.max(0, ...Object.values(r.dryStreaks)),
        createdAt: r.createdAt,
        seenAt: r.seenAt,
      }));
    return { players, count: players.length };
  }

  /** Нарахувати гравцю amount коінів. */
  @Post('players/:id/topup')
  topUp(@Param('id') id: string, @Body() dto: TopUpDto, @CurrentAdmin() session: AdminSession) {
    const telegramId = this.mustId(id);
    const balance = this.players.credit(telegramId, dto.amount, `CRM: ${session.login}`);
    if (balance === null) throw new NotFoundException('Игрок не найден');
    return { telegramId, balance, added: dto.amount };
  }

  /* Обнулити баланс.

     Окремо від поповнення й з іншим підтвердженням у CRM: поповнення
     помилкою на нуль не зробиш, а обнулення — необоротне. Повертаємо
     СКІЛЬКИ зняли, щоб адмін бачив, що саме щойно сталося, а не лише
     новий нуль. */
  @Post('players/:id/zero')
  zeroBalance(@Param('id') id: string, @CurrentAdmin() session: AdminSession) {
    const telegramId = this.mustId(id);
    const res = this.players.zeroBalance(telegramId, session.login);
    if (!res) throw new NotFoundException('Игрок не найден');
    return { telegramId, balance: res.balance, taken: res.taken };
  }

  /* Видалити гравця НАЗАВЖДИ. */
  @Post('players/:id/delete')
  removePlayer(@Param('id') id: string, @CurrentAdmin() session: AdminSession) {
    const telegramId = this.mustId(id);
    if (!this.players.remove(telegramId, session.login)) {
      throw new NotFoundException('Игрок не найден');
    }
    return { telegramId, deleted: true };
  }

  /* telegramId приходить рядком із маршруту. Перевірка була скопійована
     в кожен метод — тут вона одна, і забути її вже ніде. */
  private mustId(raw: string): number {
    const id = Number(raw);
    if (!Number.isInteger(id)) throw new NotFoundException('Игрок не найден');
    return id;
  }
}
