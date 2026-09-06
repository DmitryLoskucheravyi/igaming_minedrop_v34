import { type Collection, type Db } from 'mongodb';
import type { AdminRecord } from './admin.types';

/* Сховище адмінів — колекція `admins`, один документ = один адмін,
   _id = AdminRecord.id. Підключення приходить готове (MongoService). */

type StoredAdmin = AdminRecord & { _id: string };

export class AdminStore {
  private readonly col: Collection<StoredAdmin>;

  constructor(db: Db) {
    this.col = db.collection<StoredAdmin>('admins');
  }

  /** Унікальність логіна тримає індекс, а не тільки код: адмінів
      заводять рідко, зате ціна дубля — два різні паролі до одного
      акаунта. Індекс створюється один раз, повторний виклик безпечний. */
  async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ login: 1 }, { unique: true });
  }

  async loadAll(): Promise<AdminRecord[]> {
    const docs = await this.col.find().toArray();
    return docs.map((d) => {
      const { _id, ...rest } = d as Record<string, unknown> & { _id: string };
      void _id;
      return rest as unknown as AdminRecord;
    });
  }

  async save(rec: AdminRecord): Promise<void> {
    await this.col.replaceOne({ _id: rec.id }, { ...rec }, { upsert: true });
  }
}
