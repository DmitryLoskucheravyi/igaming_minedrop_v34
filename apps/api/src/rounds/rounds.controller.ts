import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { TIERS } from '@minedrop/engine';
import type { RoundMode, TierId } from '@minedrop/engine';
import { RoundsService } from './rounds.service';
import { PlayersService } from '../players/players.service';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';

class PlayDto {
  @IsInt() @Min(1)
  bet!: number;

  /* Режим клієнта тут довідковий: справжній визначає наявність buy,
     і саме його рушій кладе в RoundResult.mode. Тримаємо поле, щоб не
     ламати старих клієнтів, але рішення на нього не спираються. */
  @IsOptional() @IsIn(['bet', 'buy'])
  mode: RoundMode = 'bet';

  /* БОНУС БАЙ: яку кірку купують. Саме це поле й вирішує режим і ціну.
     Ціну рахує сервер із CONFIG.buy — клієнт її лише показує. Список
     тірів беремо з рушія, щоб DTO не розходився з конфігом. */
  @IsOptional() @IsIn(TIERS.map((t) => t.id))
  buy?: TierId;
}

@Controller('rounds')
@UseGuards(TelegramAuthGuard)
export class RoundsController {
  constructor(
    private readonly rounds: RoundsService,
    private readonly players: PlayersService,
  ) {}

  /* x-idempotency-key: у вебв'ю телеграма мережа рветься, клієнт
     ретраїть, і без ключа один дубль запиту = друга списана ставка. */
  @Post('play')
  play(
    @TgUser() user: TelegramUser,
    @Body() dto: PlayDto,
    @Headers('x-idempotency-key') key?: string,
  ) {
    const rec = this.players.findOrCreate(user);
    const round = this.rounds.play(rec, dto.bet, dto.mode, key, dto.buy);
    return { round, player: this.players.publicState(rec) };
  }
}
