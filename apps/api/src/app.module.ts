import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { TelegramModule } from './telegram/telegram.module';
import { PlayersModule } from './players/players.module';
import { FairnessModule } from './fairness/fairness.module';
import { RoundsModule } from './rounds/rounds.module';

@Module({
  imports: [ConfigModule, TelegramModule, PlayersModule, FairnessModule, RoundsModule],
})
export class AppModule {}
