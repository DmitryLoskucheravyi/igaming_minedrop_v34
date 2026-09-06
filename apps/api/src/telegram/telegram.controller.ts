import { Body, Controller, Headers, HttpCode, Post, ForbiddenException } from '@nestjs/common';
import { BotService } from './bot.service';

/* Точка входу вебхука. У dev не використовується — там long polling. */
@Controller('telegram')
export class TelegramController {
  constructor(private readonly bot: BotService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Body() update: unknown,
    @Headers('x-telegram-bot-api-secret-token') secret?: string,
  ) {
    const ok = await this.bot.handleUpdate(update, secret);
    if (!ok) throw new ForbiddenException('Апдейт не принят');
    return { ok: true };
  }
}
