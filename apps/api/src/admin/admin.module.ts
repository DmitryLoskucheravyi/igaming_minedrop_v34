import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { PaymentsModule } from '../payments/payments.module';
import { WithdrawModule } from '../withdrawals/withdraw.module';
import { AdminController } from './admin.controller';
import { AdminsService } from './admins.service';
import { AdminAuthGuard } from './admin-auth.guard';

@Module({
  imports: [PlayersModule, PaymentsModule, WithdrawModule],
  providers: [AdminsService, AdminAuthGuard],
  controllers: [AdminController],
})
export class AdminModule {}
