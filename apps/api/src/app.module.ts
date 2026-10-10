import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { TelegramModule } from './telegram/telegram.module';
import { PlayersModule } from './players/players.module';
import { WheelModule } from './wheel/wheel.module';
import { ReferralsModule } from './referrals/referrals.module';
import { SpinsModule } from './spins/spins.module';
import { FairnessModule } from './fairness/fairness.module';
import { RoundsModule } from './rounds/rounds.module';
import { AdminModule } from './admin/admin.module';
import { DailyModule } from './daily/daily.module';

@Module({
  imports: [
    ConfigModule, DbModule, TelegramModule, PlayersModule,
    FairnessModule, RoundsModule, DailyModule,
    AdminModule, WheelModule, ReferralsModule, SpinsModule,
  ],
})
export class AppModule {}
