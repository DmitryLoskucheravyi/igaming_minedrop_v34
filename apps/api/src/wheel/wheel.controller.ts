import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PlayersService } from '../players/players.service';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';
import { WheelService } from './wheel.service';

/* Колесо щоденного бонусу. Два роути: подивитись стан і крутнути.

   Гравця беремо через findOrCreate, як і решта ігрових роутів: колесо
   може бути найпершим, куди людина зайде після входу, і вимагати, щоб
   акаунт хтось завів до цього, — зайва умова. */
@Controller('wheel')
@UseGuards(TelegramAuthGuard)
export class WheelController {
  constructor(
    private readonly wheel: WheelService,
    private readonly players: PlayersService,
  ) {}

  @Get()
  state(@TgUser() user: TelegramUser) {
    return this.wheel.state(this.players.findOrCreate(user));
  }

  @Post('spin')
  spin(@TgUser() user: TelegramUser) {
    return this.wheel.spin(this.players.findOrCreate(user));
  }
}
