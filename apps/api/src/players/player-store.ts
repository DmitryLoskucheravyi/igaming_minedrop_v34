import { type Collection, type Db } from 'mongodb';
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

   Підключення сюди приходить готове (MongoService) — сховище не
   відкриває власного клієнта й не керує його життям.
   ============================================================ */

type StoredPlayer = PlayerRecord & { _id: number };

export class PlayerStore {
  private readonly col: Collection<StoredPlayer>;

  constructor(db: Db) {
    this.col = db.collection<StoredPlayer>('players');
  }

  /** Усі гравці з БД. Дозаповнюємо поля, яких могло не бути в старих
      документах (dryStreaks/revealed/history), щоб код далі не думав про це.
      Старе поле dryStreak (одне число) просто ігнорується — серії тепер
      живуть по ставках, невелика втрата серії при міграції прийнятна. */
  async loadAll(): Promise<PlayerRecord[]> {
    const docs = await this.col.find().toArray();
    return docs.map((d) => {
      const { _id, dryStreak, ...rest } = d as
        { _id: number; dryStreak?: number } & Record<string, unknown>;
      void _id; void dryStreak;
      return {
        dryStreaks: {},
        pendingBonus: null,
        revealed: [],
        history: [],
        /* Колесо з'явилось пізніше за перших гравців: у їхніх документах
           цих полів немає, і без дефолту вони приїхали б undefined.
           wheelAt: null тут означає, що давній гравець теж отримає свій
           перший — гарантований — прокрут. */
        wheelAt: null,
        freeSpins: 0,
        refBy: null,
        refJoinPaidAt: null,
        refDepositPaidAt: null,
        refDeposited: 0,
        ...rest,
      } as unknown as PlayerRecord;
    });
  }

  /** Повний перезапис документа гравця (_id = telegramId ставиться при upsert). */
  async save(rec: PlayerRecord): Promise<void> {
    await this.col.replaceOne({ _id: rec.telegramId }, { ...rec }, { upsert: true });
  }

  /* Видалення НАЗАВЖДИ. Разом із документом зникають баланс, сид,
     nonce й історія раундів. Заявки на депозит і виведення лежать в
     інших колекціях і не чіпаються — це фінансові документи, і
     переписувати їх заднім числом не можна навіть тут. */
  async delete(telegramId: number): Promise<void> {
    await this.col.deleteOne({ _id: telegramId });
  }
}
