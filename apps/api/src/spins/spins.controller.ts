import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsString } from 'class-validator';
import { PlayersService } from '../players/players.service';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';
import { FS_CHANCE_X, SPIN_PACKS, packById, packPrice } from './spins.types';

class BuyDto {
  @IsString()
  pack!: string;
}

/* Пакети фріспінів: один роут на список і один на покупку. Логіки тут
   майже немає — усе, що коштує грошей, робить PlayersService: списання,
   видачу прокрутів і запис у лог. */
@Controller('spins')
@UseGuards(TelegramAuthGuard)
export class SpinsController {
  constructor(private readonly players: PlayersService) {}

  @Get()
  state(@TgUser() user: TelegramUser) {
    const rec = this.players.findOrCreate(user);
    return {
      chanceX: FS_CHANCE_X,
      /* Ціни рахує сервер — клієнт їх лише показує, тож двох формул не
         буває. */
      packs: SPIN_PACKS.map((p) => ({
        id: p.id, name: p.name, spins: p.spins, bet: p.bet, price: packPrice(p),
      })),
      left: rec.buySpins ?? 0,
      bet: rec.buySpinBet ?? 0,
      balance: this.players.total(rec),
    };
  }

  @Post('buy')
  buy(@TgUser() user: TelegramUser, @Body() dto: BuyDto) {
    const rec = this.players.findOrCreate(user);
    const pack = packById(dto.pack);
    if (!pack) throw new BadRequestException('Неизвестный пакет');
    /* Докупити до незіграного пакета не можна: інакше довелось би
       вирішувати, на якій ставці грають прокрути зі старого й нового
       наборів, а вони можуть бути різні. */
    if ((rec.buySpins ?? 0) > 0) {
      throw new BadRequestException('Купленные прокруты ещё не сыграны');
    }
    return this.players.buySpins(rec, pack);
  }
}
