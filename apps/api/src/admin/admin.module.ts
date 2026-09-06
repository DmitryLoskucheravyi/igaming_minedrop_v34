import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [PlayersModule],
  controllers: [AdminController],
})
export class AdminModule {}
