import {
  Body, Controller, Get, HttpException, HttpStatus, Post, Req, UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import type { RoundMode } from '@minedrop/engine';
import { FairnessService } from './fairness.service';
import { PlayersService } from '../players/players.service';
import { TelegramAuthGuard, TgUser } from '../telegram/telegram-auth.guard';
import type { TelegramUser } from '../telegram/init-data';
import { RateLimiter, clientKey } from '../common/rate-limit';

class VerifyDto {
  @IsString() @Matches(/^[0-9a-fA-F]{64}$/, { message: 'serverSeed має бути 64 hex-символи' })
  serverSeed!: string;

  @IsOptional() @IsString() @Matches(/^[0-9a-fA-F]{64}$/)
  serverSeedHash?: string;

  @IsString()
  clientSeed!: string;

  @IsInt() @Min(1)
  nonce!: number;

  @IsOptional() @IsIn(['bet'])
  mode: RoundMode = 'bet';

  @IsInt() @Min(1)
  bet!: number;

  /* Прапорець гарантованої кірки — беруть із RoundResult.pity того
     раунду, який перевіряють. Без нього кожен восьмий раунд «не
     сходиться»: сервер грав його з іншою таблицею прокруту. */
  @IsOptional() @IsBoolean()
  pity?: boolean;
}

/* Публічний verify ганяє повну симуляцію раунду — це десятки тисяч
   кроків фізики на один запит, тобто найдорожча операція в усьому API
   і єдина, що доступна без авторизації. Ліміт per-IP плюс глобальний:
   за проксі Next усі клієнти можуть виглядати однією адресою, тому
   сам лише per-IP тут нічого не гарантує. */
const VERIFY_PER_IP = new RateLimiter(20, 60_000);
const VERIFY_GLOBAL = new RateLimiter(120, 60_000);

interface RawRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
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
    const rec = this.players.findOrCreate(user);
    const out = this.fairness.rotate(rec);
    this.players.persist(rec);   // rotate змінив serverSeed/nonce/revealed
    return out;
  }

  /* Публічна перевірка — навмисно БЕЗ авторизації: гравець має могти
     дати ці числа кому завгодно, і той перерахує раунд, не маючи
     доступу до акаунта. Стану не змінює, але коштує дорого — звідси
     ліміт частоти (див. VERIFY_PER_IP / VERIFY_GLOBAL вище). */
  @Post('verify')
  verify(@Body() dto: VerifyDto, @Req() req: RawRequest) {
    const key = clientKey(req.headers, req.ip);
    if (!VERIFY_PER_IP.take(key) || !VERIFY_GLOBAL.take('all')) {
      throw new HttpException(
        `Слишком часто. Попробуй через ${VERIFY_PER_IP.retryAfterSec(key)} с`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.fairness.verify(dto);
  }
}
