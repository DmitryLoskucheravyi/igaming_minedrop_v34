import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [PlayersModule, PaymentsModule],
  controllers: [AdminController],
})
export class AdminModule {}
