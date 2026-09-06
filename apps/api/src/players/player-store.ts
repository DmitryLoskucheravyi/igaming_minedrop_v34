import { Logger } from '@nestjs/common';
import { MongoClient, type Collection } from 'mongodb';
import type { PlayerRecord } from './players.service';

/* ============================================================
   PLAYER STORE — довговічне сховище гравців (MongoDB).

   Модель проста: у процесі працює Map (див. PlayersService), а Mongo
   тримає копію. На старті все зчитується в Map, після кожної зміни,
   що впливає на гроші (раунд, поповнення, ротація сида), запис
   повністю перезаписується в БД: replaceOne({_id: telegramId}, ...).

   Один документ = один гравець, _id = telegramId (число). Оновлення
   одного документа в Mongo атомарне, тож паралельні раунди одного
   гравця не б'ються (у dev-схемі процес усе одно один).
   ============================================================ */

type StoredPlayer = PlayerRecord & { _id: number };

export class PlayerStore {
  private readonly log = new Logger(PlayerStore.name);
  private client: MongoClient | null = null;
  private col: Collection<StoredPlayer> | null = null;

  async connect(url: string): Promise<void> {
    this.client = new MongoClient(url, {
      serverSelectionTimeoutMS: 6000,
      // dev: один вузол, без реплікації для запису
      retryWrites: false,
    });
    await this.client.connect();
    this.col = this.client.db().collection<StoredPlayer>('players');
    await this.client.db().command({ ping: 1 });
    this.log.log(`MongoDB підключено: ${new URL(url).host}/${this.client.db().databaseName}`);
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
  }

  /** Усі гравці з БД. Дозаповнюємо поля, яких могло не бути в старих
      документах (dryStreaks/revealed/history), щоб код далі не думав про це.
      Старе поле dryStreak (одне число) просто ігнорується — серії тепер
      живуть по ставках, невелика втрата серії при міграції прийнятна. */
  async loadAll(): Promise<PlayerRecord[]> {
    if (!this.col) return [];
    const docs = await this.col.find().toArray();
    return docs.map((d) => {
      const { _id, dryStreak, ...rest } = d as
        { _id: number; dryStreak?: number } & Record<string, unknown>;
      void _id; void dryStreak;
      return {
        dryStreaks: {},
        revealed: [],
        history: [],
        ...rest,
      } as unknown as PlayerRecord;
    });
  }

  /** Повний перезапис документа гравця (_id = telegramId ставиться при upsert). */
  async save(rec: PlayerRecord): Promise<void> {
    if (!this.col) return;
    const doc: PlayerRecord = { ...rec };
    await this.col.replaceOne({ _id: rec.telegramId }, doc, { upsert: true });
  }
}
