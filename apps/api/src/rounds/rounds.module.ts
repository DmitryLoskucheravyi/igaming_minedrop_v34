import { Module } from '@nestjs/common';
import { RoundsService } from './rounds.service';
import { RoundsController } from './rounds.controller';
import { PlayersModule } from '../players/players.module';
import { FairnessModule } from '../fairness/fairness.module';

@Module({
  imports: [PlayersModule, FairnessModule],
  providers: [RoundsService],
  controllers: [RoundsController],
})
export class RoundsModule {}
