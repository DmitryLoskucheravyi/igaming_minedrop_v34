import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { SettingsModule } from './settings/settings.module';
import { TelegramModule } from './telegram/telegram.module';
import { PlayersModule } from './players/players.module';
import { FairnessModule } from './fairness/fairness.module';
import { RoundsModule } from './rounds/rounds.module';
import { RatesModule } from './rates/rates.module';
import { AdminModule } from './admin/admin.module';
import { PaymentsModule } from './payments/payments.module';
import { WithdrawModule } from './withdrawals/withdraw.module';

@Module({
  imports: [
    ConfigModule, DbModule, SettingsModule, RatesModule, TelegramModule, PlayersModule,
    FairnessModule, RoundsModule, PaymentsModule, WithdrawModule, AdminModule,
  ],
})
export class AppModule {}
