import { type Collection, type Db } from 'mongodb';
import { CONFIG } from '@minedrop/engine';
import type { PlayerRecord } from './players.service';

/* ============================================================
   PLAYER STORE — довговічне сховище гравців (MongoDB).

   Модель проста: у процесі працює Map (див. PlayersService), а Mongo
   тримає копію. На старті все зчитується в Map, після кожної зміни
   запис повністю перезаписується в БД: replaceOne({_id: telegramId}, ...).

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

     ПЕРЕХІД НА КОІНИ. Колись у гравця були гроші: одне поле balance, а
     пізніше два — cash і bonus (плюс накопичувач фріспінів). Тепер
     валюта одна, і все це складається в coins один до одного. Нижче
     стартового балансу нікого не лишаємо: нова економіка починається з
     CONFIG.startBalance для всіх, а не лише для новачків.

     Решта старих полів (відіграш, депозити, термін бонусу) просто
     відкидається — їх більше ніхто не читає. */
  async loadAll(): Promise<PlayerRecord[]> {
    const docs = await this.col.find().toArray();
    return docs.map((d) => {
      const {
        _id, dryStreak, balance, cash, bonus, freeSpinWin,
        bonusLocked, bonusTarget, turnover, wagerNeed, wagerDone, bonusUntil, bonusCap,
        refDeposited, refDepositPaidAt,
        ...rest
      } = d as {
        _id: number; dryStreak?: number; balance?: number; cash?: number; bonus?: number;
        freeSpinWin?: number;
      } & Record<string, unknown>;
      void _id; void dryStreak; void bonusLocked; void bonusTarget; void turnover;
      void wagerNeed; void wagerDone; void bonusUntil; void bonusCap;
      void refDeposited; void refDepositPaidAt;

      const legacy = rest.coins === undefined ? {
        coins: Math.max(
          CONFIG.startBalance,
          Math.floor((balance ?? 0) + (cash ?? 0) + (bonus ?? 0) + (freeSpinWin ?? 0)),
        ),
      } : {};

      return {
        dryStreaks: {},
        pendingBonus: null,
        revealed: [],
        history: [],
        /* wheelAt: null тут означає, що давній гравець теж отримає свій
           перший — гарантований — прокрут колеса. */
        wheelAt: null,
        freeSpins: 0,
        refBy: null,
        refJoinPaidAt: null,
        buySpins: 0,
        buySpinBet: 0,
        dailyDay: null,
        streak: 0,
        coins: CONFIG.startBalance,
        ...rest,
        ...legacy,
      } as unknown as PlayerRecord;
    });
  }

  /** Повний перезапис документа гравця (_id = telegramId ставиться при upsert). */
  async save(rec: PlayerRecord): Promise<void> {
    await this.col.replaceOne({ _id: rec.telegramId }, { ...rec }, { upsert: true });
  }

  /* Видалення НАЗАВЖДИ: разом із документом зникають баланс, сид,
     nonce, серія заходів й історія раундів. */
  async delete(telegramId: number): Promise<void> {
    await this.col.deleteOne({ _id: telegramId });
  }
}
