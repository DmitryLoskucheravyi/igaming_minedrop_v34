import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { AdminsService } from './admins.service';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthController } from './admin-auth.controller';
import { AdminPlayersController } from './admin-players.controller';

/* CRM тепер про одне — гравців і їхні коіни. Відкриті маршрути (вхід,
   обмін токена) живуть в окремому контролері, щоб їх було видно. */
@Module({
  imports: [PlayersModule],
  providers: [AdminsService, AdminAuthGuard],
  controllers: [AdminAuthController, AdminPlayersController],
})
export class AdminModule {}
