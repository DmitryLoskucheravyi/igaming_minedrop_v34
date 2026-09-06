import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { MongoClient, type Db } from 'mongodb';
import { ENV, type Env } from '../config/env';

/* ============================================================
   MONGO — ОДНЕ підключення на весь застосунок.

   Раніше кожне сховище (гравці, платежі) відкривало власний
   MongoClient до тієї самої бази: два пули з'єднань, два ping,
   дві точки відмови й два різні місця, де вирішується, що робити
   при недоступній базі. Тепер клієнт один, а сховища беруть з
   нього готовий Db.

   Підключення ЛІНИВЕ і кешоване в промісі: перший, хто попросив
   ready(), запускає конект, решта чекають на той самий проміс.
   Так немає жодної залежності від того, у якому порядку Nest
   викликає onModuleInit у модулів.

   Порожній MONGO_URL — це не помилка, а dev-режим без БД:
   ready() віддає null, сховища лишаються в пам'яті. У продакшні
   недоступна база — помилка старту.
   ============================================================ */

@Injectable()
export class MongoService implements OnModuleDestroy {
  private readonly log = new Logger(MongoService.name);
  private client: MongoClient | null = null;
  private connecting: Promise<Db | null> | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Готова база або null (dev без MONGO_URL). Конектить один раз. */
  ready(): Promise<Db | null> {
    if (!this.connecting) this.connecting = this.connect();
    return this.connecting;
  }

  private async connect(): Promise<Db | null> {
    const url = this.env.mongoUrl;
    if (!url) {
      this.log.warn('MONGO_URL не заданий — усе сховище лише в пам\'яті, гине з рестартом.');
      return null;
    }

    const client = new MongoClient(url, {
      serverSelectionTimeoutMS: 6000,
      // dev: один вузол, без реплікації для запису
      retryWrites: false,
    });

    try {
      await client.connect();
      const db = client.db();
      await db.command({ ping: 1 });
      this.client = client;
      this.log.log(`MongoDB підключено: ${new URL(url).host}/${db.databaseName}`);
      return db;
    } catch (e) {
      await client.close().catch(() => undefined);
      const msg = (e as Error).message;
      if (this.env.isProd) throw new Error(`MongoDB недоступна: ${msg}`);
      this.log.error(`MongoDB недоступна (${msg}). Працюємо в пам'яті — стан НЕ зберігається.`);
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close().catch(() => undefined);
  }
}
