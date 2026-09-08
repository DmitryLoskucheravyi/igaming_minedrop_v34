import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';

/* Глобальний: налаштування прийому читають і платежі, і CRM, і
   майбутній спостерігач. */
@Global()
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
