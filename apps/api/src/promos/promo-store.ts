import { type Collection, type Db } from 'mongodb';
import type { PromoCode } from './promo.types';

/* Довговічне сховище промокодів. Той самий підхід, що в PlayerStore і
   PaymentStore: істина — Map у процесі, Mongo — дзеркало, один
   документ = один код (_id = id). Підключення приходить готове з
   MongoService, власного клієнта тут немає. */

type Stored = PromoCode & { _id: string };

export class PromoStore {
  private readonly col: Collection<Stored>;

  constructor(db: Db) {
    this.col = db.collection<Stored>('promos');
  }

  async loadAll(): Promise<PromoCode[]> {
    return (await this.col.find().toArray()).map((d) => {
      const { _id, ...rest } = d;
      void _id;
      return rest as unknown as PromoCode;
    });
  }

  async save(p: PromoCode): Promise<void> {
    await this.col.replaceOne({ _id: p.id }, { ...p }, { upsert: true });
  }

  async remove(id: string): Promise<void> {
    await this.col.deleteOne({ _id: id });
  }
}
