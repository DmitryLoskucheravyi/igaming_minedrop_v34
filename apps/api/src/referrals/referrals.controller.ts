import { Controller, Get, UseGuards } from '@nestjs/common';
import { PlayersService } from '../players/players.service';
import { TelegramAuthGuard, TgStart, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';
import { ReferralsService } from './referrals.service';

/* Реферальний кабінет: своє посилання, список друзів і скільки на них
   зароблено.

   findOrCreate тут не випадковий: саме цим роутом гравець може вперше
   відкрити гру, прийшовши за чужим посиланням. Стартовий параметр
   передаємо далі — прив'язка робиться в момент створення запису й
   тільки тоді. */
@Controller('referrals')
@UseGuards(TelegramAuthGuard)
export class ReferralsController {
  constructor(
    private readonly referrals: ReferralsService,
    private readonly players: PlayersService,
  ) {}

  @Get('me')
  me(@TgUser() user: TelegramUser, @TgStart() start: string | undefined) {
    return this.referrals.state(this.players.findOrCreate(user, start));
  }
}
