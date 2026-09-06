import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { PaymentsService } from './payments.service';
import { PlayersService } from '../players/players.service';
import { PAYMENT_MAX_RUB, PAYMENT_MIN_RUB, type PaymentMethod } from './payment.types';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';

class CreateDto {
  @IsInt() @Min(PAYMENT_MIN_RUB) @Max(PAYMENT_MAX_RUB)
  amount!: number;

  @IsIn(['usdt_trc20'])
  method!: PaymentMethod;
}

@Controller('payments')
@UseGuards(TelegramAuthGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly players: PlayersService,
  ) {}

  /** Історія платежів + активна заявка (якщо є). */
  @Get('me')
  me(@TgUser() user: TelegramUser) {
    this.players.findOrCreate(user);   // на випадок першого звернення
    return {
      active: this.payments.activeFor(user.id) ?? null,
      history: this.payments.listForPlayer(user.id),
      minRub: PAYMENT_MIN_RUB,
      maxRub: PAYMENT_MAX_RUB,
    };
  }

  /** Створити заявку на депозит. Далі гравець нічого не тисне —
      лише переказує USDT на видану адресу до закінчення таймера. */
  @Post()
  create(@TgUser() user: TelegramUser, @Body() dto: CreateDto) {
    this.players.findOrCreate(user);
    return this.payments.create(user.id, dto.amount, dto.method);
  }
}
