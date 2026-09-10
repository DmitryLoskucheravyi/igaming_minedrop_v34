import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { PaymentsModule } from '../payments/payments.module';
import { WithdrawModule } from '../withdrawals/withdraw.module';
import { WatcherModule } from '../watcher/watcher.module';
import { AdminsService } from './admins.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthController } from './admin-auth.controller';
import { AdminPlayersController } from './admin-players.controller';
import { AdminRequestsController } from './admin-requests.controller';
import { AdminDepositsController } from './admin-deposits.controller';

/* Один контролер на 27 маршрутів і шість сервісів у конструкторі
   розібраний на чотири — рівно за вкладками CRM. Кожен бачить тільки
   те, з чим працює його вкладка, і відкриті маршрути (вхід, обмін
   токена) видно окремо, а не серед сорока інших. */
@Module({
  imports: [PlayersModule, PaymentsModule, WithdrawModule, WatcherModule],
  providers: [AdminsService, AdminAuthGuard],
  controllers: [
    AdminAuthController,
    AdminPlayersController,
    AdminRequestsController,
    AdminDepositsController,
  ],
})
export class AdminModule {}
