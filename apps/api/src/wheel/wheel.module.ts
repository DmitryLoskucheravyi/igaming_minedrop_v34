import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { WheelController } from './wheel.controller';
import { WheelService } from './wheel.service';

@Module({
  imports: [PlayersModule],
  providers: [WheelService],
  controllers: [WheelController],
})
export class WheelModule {}
