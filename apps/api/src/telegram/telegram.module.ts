import { Global, Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { TelegramController } from './telegram.controller';
import { TelegramAuthGuard } from './telegram-auth.guard';

@Global()
@Module({
  providers: [BotService, TelegramAuthGuard],
  controllers: [TelegramController],
  exports: [BotService, TelegramAuthGuard],
})
export class TelegramModule {}
