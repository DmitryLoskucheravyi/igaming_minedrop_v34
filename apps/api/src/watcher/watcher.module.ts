import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { WatcherService } from './watcher.service';

/* Спостерігач нічого не експортує назовні, крім себе для CRM: усе, що
   він робить із грошима, він робить через PaymentsService. */
@Module({
  imports: [PaymentsModule],
  providers: [WatcherService],
  exports: [WatcherService],
})
export class WatcherModule {}
