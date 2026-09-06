import { Global, Module } from '@nestjs/common';
import { MongoService } from './mongo.service';

/* Глобальний модуль: підключення до Mongo одне на весь застосунок,
   інжектиться будь-де без окремого import (див. mongo.service.ts). */
@Global()
@Module({
  providers: [MongoService],
  exports: [MongoService],
})
export class DbModule {}
