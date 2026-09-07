import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { WithdrawService } from './withdraw.service';
import { WithdrawController } from './withdraw.controller';

@Module({
  imports: [PlayersModule],
  providers: [WithdrawService],
  controllers: [WithdrawController],
  exports: [WithdrawService],
})
export class WithdrawModule {}
