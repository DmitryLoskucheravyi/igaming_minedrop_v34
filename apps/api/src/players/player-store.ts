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

  /* Усі гравці з БД.

     Тут же живе МІГРАЦІЯ старих документів. Правило одне: код вище не
     має знати, якого віку запис, тому всі поля, додані пізніше,
     дозаповнюються саме тут.

     ПЕРЕХІД НА ДВА БАЛАНСИ. Колись було одне поле balance плюс число
     bonusLocked («скільки з нього не виводиться»). Розкладаємо його
     чесно: замкнена частина стає бонусним балансом, решта — готівкою.
     Невиконаний залишок відіграшу (bonusTarget - turnover) переїжджає
     у wagerNeed, а прогрес починається з нуля — від нової бази його
     однаково не відрахувати.

     Старе поле dryStreak (одне число) просто ігнорується: серії тепер
     живуть по ставках, невелика втрата серії при міграції прийнятна. */
  async loadAll(): Promise<PlayerRecord[]> {
    const docs = await this.col.find().toArray();
    return docs.map((d) => {
      const {
        _id, dryStreak, balance, bonusLocked, bonusTarget, turnover, ...rest
      } = d as {
        _id: number; dryStreak?: number; balance?: number;
        bonusLocked?: number; bonusTarget?: number; turnover?: number;
      } & Record<string, unknown>;
      void _id; void dryStreak;

      const locked = Math.max(0, Math.min(bonusLocked ?? 0, balance ?? 0));
      const legacy = balance === undefined ? {} : {
        cash: Math.max(0, (balance ?? 0) - locked),
        bonus: locked,
        wagerNeed: Math.max(0, (bonusTarget ?? 0) - (turnover ?? 0)),
        wagerDone: 0,
      };

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
        cash: 0,
        bonus: 0,
        wagerNeed: 0,
        wagerDone: 0,
        bonusUntil: 0,
        bonusCap: 0,
        freeSpinWin: 0,
        buySpins: 0,
        buySpinBet: 0,
        ...rest,
        /* Розклад зі старого balance кладеться ПІСЛЯ rest: він точніший
           за дефолти й має перекривати їх, але тільки якщо старе поле
           взагалі було. */
        ...legacy,
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
