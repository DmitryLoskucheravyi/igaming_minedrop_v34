import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import type { RoundMode } from '@minedrop/engine';
import { FairnessService } from './fairness.service';
import { PlayersService } from '../players/players.service';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';

class VerifyDto {
  @IsString() @Matches(/^[0-9a-fA-F]{64}$/, { message: 'serverSeed має бути 64 hex-символи' })
  serverSeed!: string;

  @IsOptional() @IsString() @Matches(/^[0-9a-fA-F]{64}$/)
  serverSeedHash?: string;

  @IsString()
  clientSeed!: string;

  @IsInt() @Min(1)
  nonce!: number;

  @IsIn(['bet', 'bonus-buy', 'bonus-streak'])
  mode!: RoundMode;

  @IsInt() @Min(1)
  bet!: number;
}

@Controller('fairness')
export class FairnessController {
  constructor(
    private readonly fairness: FairnessService,
    private readonly players: PlayersService,
  ) {}

  /** Що опубліковано зараз + що вже розкрито */
  @Get('me')
  @UseGuards(TelegramAuthGuard)
  me(@TgUser() user: TelegramUser) {
    const rec = this.players.findOrCreate(user);
    return {
      current: { serverSeedHash: rec.serverSeedHash, clientSeed: rec.clientSeed, nonce: rec.nonce },
      revealed: rec.revealed,
    };
  }

  /** Закрити серію й розкрити сид */
  @Post('rotate')
  @UseGuards(TelegramAuthGuard)
  rotate(@TgUser() user: TelegramUser) {
    return this.fairness.rotate(this.players.findOrCreate(user));
  }

  /* Публічна перевірка — навмисно БЕЗ авторизації: гравець має могти
     дати ці числа кому завгодно, і той перерахує раунд, не маючи
     доступу до акаунта. Стану не змінює. */
  @Post('verify')
  verify(@Body() dto: VerifyDto) {
    return this.fairness.verify(dto);
  }
}
