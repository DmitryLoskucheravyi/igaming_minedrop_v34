import {
  Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post,
} from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { ENV, type Env } from '../config/env';
import { PlayersService } from '../players/players.service';

/* ============================================================
   ADMIN — тимчасова панель на час тестів. БЕЗ авторизації, тому
   доступна ТІЛЬКИ поза продакшном (loadEnv().isProd === false).
   Список гравців + ручне поповнення балансу.
   ============================================================ */

class TopUpDto {
  @IsInt() @Min(1) @Max(100_000_000)
  amount!: number;
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly players: PlayersService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private guard(): void {
    if (this.env.isProd) {
      throw new ForbiddenException('Админ-панель недоступна в продакшне');
    }
  }

  /** Усі гравці, свіжіші зверху. */
  @Get('players')
  list() {
    this.guard();
    const players = this.players.all()
      .sort((a, b) => b.seenAt - a.seenAt)
      .map((r) => ({
        telegramId: r.telegramId,
        firstName: r.firstName,
        username: r.username ?? null,
        balance: r.balance,
        nonce: r.nonce,
        dryStreak: r.dryStreak,
        createdAt: r.createdAt,
        seenAt: r.seenAt,
      }));
    return { players, count: players.length };
  }

  /** Поповнити баланс гравця на amount (рублів). */
  @Post('players/:id/topup')
  topUp(@Param('id') id: string, @Body() dto: TopUpDto) {
    this.guard();
    const balance = this.players.topUp(Number(id), dto.amount);
    if (balance === null) throw new NotFoundException('Игрок не найден');
    return { telegramId: Number(id), balance, added: dto.amount };
  }
}
