import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';
import { WithdrawService } from './withdraw.service';
import { PlayersService } from '../players/players.service';
import { WITHDRAW_MAX_RUB, WITHDRAW_MIN_RUB, type WithdrawMethod } from './withdraw.types';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';

class CreateDto {
  @IsInt() @Min(WITHDRAW_MIN_RUB) @Max(WITHDRAW_MAX_RUB)
  amount!: number;

  /* Адреса ГРАВЦЯ — куди відправляти. Формат перевіряє сервіс; тут
     лише довжина, щоб не тягти в валідатор регулярку двічі. */
  @IsString() @MaxLength(64)
  address!: string;

  @IsIn(['usdt_trc20'])
  method!: WithdrawMethod;
}

@Controller('withdrawals')
@UseGuards(TelegramAuthGuard)
export class WithdrawController {
  constructor(
    private readonly withdraw: WithdrawService,
    private readonly players: PlayersService,
  ) {}

  /** Історія виводів + активна заявка. */
  @Get('me')
  me(@TgUser() user: TelegramUser) {
    const rec = this.players.findOrCreate(user);
    return {
      active: this.withdraw.activeFor(user.id) ?? null,
      history: this.withdraw.listForPlayer(user.id),
      minRub: WITHDRAW_MIN_RUB,
      maxRub: WITHDRAW_MAX_RUB,
      bonus: this.players.bonusProgress(rec),
      available: this.players.withdrawable(rec),
    };
  }

  /** Створити заявку. Баланс списується одразу — див. withdraw.types.ts. */
  @Post()
  create(@TgUser() user: TelegramUser, @Body() dto: CreateDto) {
    this.players.findOrCreate(user);
    const rec = this.withdraw.create(user.id, dto.amount, dto.address, dto.method);
    // баланс змінився просто зараз — віддаємо свіжий, щоб клієнт не гадав
    return { withdraw: rec, player: this.players.publicState(this.players.findOrCreate(user)) };
  }

  /** Скасувати власну заявку, поки вона в очікуванні. Гроші повертаються. */
  @Post(':id/cancel')
  cancel(@TgUser() user: TelegramUser, @Param('id') id: string) {
    const rec = this.withdraw.cancel(user.id, id);
    return { withdraw: rec, player: this.players.publicState(this.players.findOrCreate(user)) };
  }
}
