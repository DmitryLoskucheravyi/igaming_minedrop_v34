import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { SpinsController } from './spins.controller';

@Module({
  imports: [PlayersModule],
  controllers: [SpinsController],
})
export class SpinsModule {}
