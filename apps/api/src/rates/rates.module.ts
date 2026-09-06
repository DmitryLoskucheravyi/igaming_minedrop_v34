import { Global, Module } from '@nestjs/common';
import { RatesService } from './rates.service';

/* Глобальний: курс потрібен будь-де, де формується публічний конфіг. */
@Global()
@Module({
  providers: [RatesService],
  exports: [RatesService],
})
export class RatesModule {}
