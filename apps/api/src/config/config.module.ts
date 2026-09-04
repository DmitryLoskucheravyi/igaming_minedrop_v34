import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './env';

/* Глобальний провайдер оточення: loadEnv() виконується один раз
   на старті й кидає, якщо в проді немає токена бота. */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: loadEnv }],
  exports: [ENV],
})
export class ConfigModule {}
