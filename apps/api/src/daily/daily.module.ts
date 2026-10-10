import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { DailyController } from './daily.controller';
import { DailyService } from './daily.service';

@Module({
  imports: [PlayersModule],
  providers: [DailyService],
  controllers: [DailyController],
})
export class DailyModule {}
