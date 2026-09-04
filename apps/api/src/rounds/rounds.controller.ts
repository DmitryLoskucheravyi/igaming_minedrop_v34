import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, Min } from 'class-validator';
import type { RoundMode } from '@minedrop/engine';
import { RoundsService } from './rounds.service';
import { PlayersService } from '../players/players.service';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';

class PlayDto {
  @IsInt() @Min(1)
  bet!: number;

  @IsIn(['bet', 'bonus-buy', 'bonus-streak'])
  mode!: RoundMode;
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
    const round = this.rounds.play(rec, dto.bet, dto.mode, key);
    return { round, player: this.players.publicState(rec) };
  }
}
