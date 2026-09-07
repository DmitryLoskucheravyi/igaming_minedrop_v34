import { type Collection, type Db } from 'mongodb';
import type { WithdrawRecord } from './withdraw.types';

/* Сховище заявок на виведення — колекція `withdrawals`. Той самий
   підхід, що й у решти: у процесі Map, у Mongo копія, один документ =
   одна заявка (_id = id). Підключення приходить готове з MongoService. */

type Stored = WithdrawRecord & { _id: string };

export class WithdrawStore {
  private readonly col: Collection<Stored>;

  constructor(db: Db) {
    this.col = db.collection<Stored>('withdrawals');
  }

  async loadAll(): Promise<WithdrawRecord[]> {
    const docs = await this.col.find().toArray();
    return docs.map((d) => {
      const { _id, ...rest } = d as Record<string, unknown> & { _id: string };
      void _id;
      return rest as unknown as WithdrawRecord;
    });
  }

  async save(rec: WithdrawRecord): Promise<void> {
    await this.col.replaceOne({ _id: rec.id }, { ...rec }, { upsert: true });
  }
}
