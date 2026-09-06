import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CONFIG } from '@minedrop/engine';
import { PlayersService } from './players.service';
import { RatesService } from '../rates/rates.service';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';

class ClientSeedDto {
  @IsString() @MaxLength(128)
  clientSeed!: string;
}

class HistoryQueryDto {
  @IsOptional() @IsInt() @Min(1) @Max(50)
  limit?: number;
}

@Controller('players')
@UseGuards(TelegramAuthGuard)
export class PlayersController {
  constructor(
    private readonly players: PlayersService,
    private readonly rates: RatesService,
  ) {}

  /** Стан гравця. Перший виклик заводить його — окремої «реєстрації» немає,
      бо особу вже підтвердив телеграм. */
  @Get('me')
  me(@TgUser() user: TelegramUser) {
    const rec = this.players.findOrCreate(user);
    return { ...this.players.publicState(rec), config: publicConfig(this.rates) };
  }

  @Post('me/client-seed')
  setSeed(@TgUser() user: TelegramUser, @Body() dto: ClientSeedDto) {
    const rec = this.players.findOrCreate(user);
    return this.players.publicState(this.players.setClientSeed(rec, dto.clientSeed));
  }

  @Get('me/history')
  history(@TgUser() user: TelegramUser, @Query() q: HistoryQueryDto) {
    const rec = this.players.findOrCreate(user);
    return { rounds: rec.history.slice(0, q.limit ?? 20) };
  }
}

/* Клієнт має власну копію рушія, тому конфіг йому потрібен лише
   для перевірки, що версії правил зійшлися. Плюс курс валют —
   для косметичного перерахунку балансу в USDT / зірки. */
function publicConfig(rates: RatesService) {
  return {
    bets: CONFIG.bets,
    spinsPerBet: CONFIG.spinsPerBet,
    payoutK: CONFIG.payoutK,
    maxWinX: CONFIG.maxWinX,
    rates: rates.snapshot(),
  };
}
