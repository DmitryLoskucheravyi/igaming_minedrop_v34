import { Module } from '@nestjs/common';
import { FairnessService } from './fairness.service';
import { FairnessController } from './fairness.controller';
import { PlayersModule } from '../players/players.module';

@Module({
  imports: [PlayersModule],
  providers: [FairnessService],
  controllers: [FairnessController],
  exports: [FairnessService],
})
export class FairnessModule {}
