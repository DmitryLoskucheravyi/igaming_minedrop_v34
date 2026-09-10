import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { PaymentsService } from './payments.service';
import { PlayersService } from '../players/players.service';
import { SettingsService } from '../settings/settings.service';
import { PAYMENT_MAX_RUB, PAYMENT_MIN_RUB } from './payment.types';
import { NETWORKS, TOKENS, type NetworkId, type TokenId } from './networks';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';

class CreateDto {
  @IsInt() @Min(PAYMENT_MIN_RUB) @Max(PAYMENT_MAX_RUB)
  amount!: number;

  /* Список беремо з каталогу мереж, щоб DTO не розходився з ним.
     Чи ввімкнена конкретна мережа зараз — вирішує вже сервіс. */
  @IsIn(Object.keys(NETWORKS))
  network!: NetworkId;

  @IsIn(Object.keys(TOKENS))
  token!: TokenId;
}

@Controller('payments')
@UseGuards(TelegramAuthGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly players: PlayersService,
    private readonly settings: SettingsService,
  ) {}

  /** Історія платежів + активна заявка (якщо є). */
  @Get('me')
  me(@TgUser() user: TelegramUser) {
    this.players.findOrCreate(user);   // на випадок першого звернення
    const cfg = this.settings.getDeposits();
    const rate = this.payments.currentRate();
    return {
      active: this.payments.activeFor(user.id) ?? null,
      history: this.payments.listForPlayer(user.id),
      minRub: PAYMENT_MIN_RUB,
      maxRub: PAYMENT_MAX_RUB,
      /* Курс — щоб гравець бачив, скільки USDT вийде, ДО створення
         заявки. Скасувати її можна лише поки переказу немає, тож
         дізнаватись ціну постфактум — це дізнаватись запізно. */
      rate: rate.rubPerUsdt,
      rateApprox: rate.approx,
      /* Годинник телефону буває збитий на години, а таймер заявки
         рахується як expiresAt - now. Віддаємо СВІЙ час, щоб клієнт
         міг порахувати поправку й не лякати людину «істекло» на
         живій заявці. */
      now: Date.now(),
      /* Що саме показувати у виборі — вирішує сервер: список увімкнених
         мереж міняється в CRM на ходу, і клієнт не має його вгадувати.
         Разом із мережею віддаємо комісію й доступні в ній токени. */
      networks: cfg.networks
        .filter((id) => NETWORKS[id])
        .map((id) => ({
          id,
          name: NETWORKS[id].name,
          feeUsd: NETWORKS[id].feeUsd,
          memo: !!NETWORKS[id].memo,
          tokens: cfg.tokens.filter((t) => !!NETWORKS[id].tokens[t]),
        })),
    };
  }

  /** Створити заявку на депозит. Далі гравець нічого не тисне —
      лише переказує USDT на видану адресу до закінчення таймера. */
  @Post()
  create(@TgUser() user: TelegramUser, @Body() dto: CreateDto) {
    this.players.findOrCreate(user);
    return this.payments.create(user.id, dto.amount, dto.network, dto.token);
  }

  /* Зняти власну заявку, поки переказу ще немає. Без цього помилка в
     сумі чи мережі коштувала півгодини очікування: друга заявка не
     створюється, доки висить перша. */
  @Post(':id/cancel')
  cancel(@TgUser() user: TelegramUser, @Param('id') id: string) {
    return this.payments.cancelByPlayer(user.id, id);
  }
}
