import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsInt } from 'class-validator';
import { CONFIG } from '@minedrop/engine';
import { PlayersService } from '../players/players.service';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';
import { FS_CHANCE_X, FS_PACK, spinsPrice } from './spins.types';

class BuyDto {
  @IsInt()
  bet!: number;
}

/* Купівля пакета фріспінів. Один роут на стан і один на покупку —
   логіки тут майже немає, бо все, що коштує грошей, робить
   PlayersService: списання, нарахування пакета й запис у лог. */
@Controller('spins')
@UseGuards(TelegramAuthGuard)
export class SpinsController {
  constructor(private readonly players: PlayersService) {}

  @Get()
  state(@TgUser() user: TelegramUser) {
    const rec = this.players.findOrCreate(user);
    return {
      pack: FS_PACK,
      chanceX: FS_CHANCE_X,
      /* Ціни на всі дозволені ставки одразу: клієнт показує їх у
         вибиралці, а рахує їх сервер — щоб не було двох формул. */
      prices: Object.fromEntries(CONFIG.bets.map((b) => [b, spinsPrice(b)])),
      left: rec.buySpins ?? 0,
      bet: rec.buySpinBet ?? 0,
      balance: rec.balance,
    };
  }

  @Post('buy')
  buy(@TgUser() user: TelegramUser, @Body() dto: BuyDto) {
    const rec = this.players.findOrCreate(user);
    if (!CONFIG.bets.includes(dto.bet as never)) {
      throw new BadRequestException(`Ставка должна быть одной из: ${CONFIG.bets.join(', ')}`);
    }
    /* Докупити до непрограного пакета не можна: інакше довелось би
       вирішувати, на якій ставці грають прокрути зі старого й нового
       наборів, а вони можуть бути різні. */
    if ((rec.buySpins ?? 0) > 0) {
      throw new BadRequestException('Купленные прокруты ещё не сыграны');
    }
    return this.players.buySpins(rec, dto.bet);
  }
}
