import { type Collection, type Db } from 'mongodb';
import type { DepositAddress, PaymentRecord } from './payment.types';
import type { UnmatchedPayment } from './unmatched.types';

/* Довговічне сховище заявок і адрес. Той самий підхід, що й у
   PlayerStore: у процесі — Map (PaymentsService), у Mongo — копія,
   один документ = одна заявка / адреса (_id = id). Підключення
   приходить готове з MongoService — власного клієнта тут немає. */

type Stored<T> = T & { _id: string };

export class PaymentStore {
  private readonly payCol: Collection<Stored<PaymentRecord>>;
  private readonly addrCol: Collection<Stored<DepositAddress>>;
  private readonly unCol: Collection<Stored<UnmatchedPayment>>;

  constructor(db: Db) {
    this.payCol = db.collection<Stored<PaymentRecord>>('payments');
    this.addrCol = db.collection<Stored<DepositAddress>>('deposit_addresses');
    this.unCol = db.collection<Stored<UnmatchedPayment>>('unmatched_payments');
  }

  private strip<T>(d: Record<string, unknown>): T {
    const { _id, ...rest } = d;
    void _id;
    return rest as unknown as T;
  }

  async loadAll(): Promise<PaymentRecord[]> {
    return (await this.payCol.find().toArray()).map((d) => this.strip<PaymentRecord>(d));
  }
  async save(rec: PaymentRecord): Promise<void> {
    await this.payCol.replaceOne({ _id: rec.id }, { ...rec }, { upsert: true });
  }

  async loadAddresses(): Promise<DepositAddress[]> {
    return (await this.addrCol.find().toArray()).map((d) => this.strip<DepositAddress>(d));
  }
  async saveAddress(a: DepositAddress): Promise<void> {
    await this.addrCol.replaceOne({ _id: a.id }, { ...a }, { upsert: true });
  }
  async deleteAddress(id: string): Promise<void> {
    await this.addrCol.deleteOne({ _id: id });
  }

  async loadUnmatched(): Promise<UnmatchedPayment[]> {
    return (await this.unCol.find().toArray()).map((d) => this.strip<UnmatchedPayment>(d));
  }
  async saveUnmatched(u: UnmatchedPayment): Promise<void> {
    await this.unCol.replaceOne({ _id: u.id }, { ...u }, { upsert: true });
  }
}
