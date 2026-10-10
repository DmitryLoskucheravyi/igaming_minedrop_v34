import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PlayersService } from '../players/players.service';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';
import { DailyService } from './daily.service';

/* Щоденна нагорода. Два роути: подивитись календар і забрати.

   Гравця беремо через findOrCreate, як і решта ігрових роутів: це
   вікно відкривається найпершим після входу. */
@Controller('daily')
@UseGuards(TelegramAuthGuard)
export class DailyController {
  constructor(
    private readonly daily: DailyService,
    private readonly players: PlayersService,
  ) {}

  @Get()
  state(@TgUser() user: TelegramUser) {
    return this.daily.state(this.players.findOrCreate(user));
  }

  @Post('claim')
  claim(@TgUser() user: TelegramUser) {
    return this.daily.claim(this.players.findOrCreate(user));
  }
}
