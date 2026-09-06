import { Logger } from '@nestjs/common';
import { MongoClient, type Collection } from 'mongodb';
import type { DepositAddress, PaymentRecord } from './payment.types';

/* Довговічне сховище заявок і адрес. Той самий підхід, що й у
   PlayerStore: у процесі — Map (PaymentsService), у Mongo — копія,
   один документ = одна заявка / адреса (_id = id). */

type Stored<T> = T & { _id: string };

export class PaymentStore {
  private readonly log = new Logger(PaymentStore.name);
  private client: MongoClient | null = null;
  private payCol: Collection<Stored<PaymentRecord>> | null = null;
  private addrCol: Collection<Stored<DepositAddress>> | null = null;

  async connect(url: string): Promise<void> {
    this.client = new MongoClient(url, { serverSelectionTimeoutMS: 6000, retryWrites: false });
    await this.client.connect();
    const db = this.client.db();
    this.payCol = db.collection<Stored<PaymentRecord>>('payments');
    this.addrCol = db.collection<Stored<DepositAddress>>('deposit_addresses');
    await db.command({ ping: 1 });
    this.log.log('MongoDB (payments) підключено');
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
  }

  private strip<T>(d: Record<string, unknown>): T {
    const { _id, ...rest } = d;
    void _id;
    return rest as unknown as T;
  }

  async loadAll(): Promise<PaymentRecord[]> {
    if (!this.payCol) return [];
    return (await this.payCol.find().toArray()).map((d) => this.strip<PaymentRecord>(d));
  }
  async save(rec: PaymentRecord): Promise<void> {
    if (!this.payCol) return;
    await this.payCol.replaceOne({ _id: rec.id }, { ...rec }, { upsert: true });
  }

  async loadAddresses(): Promise<DepositAddress[]> {
    if (!this.addrCol) return [];
    return (await this.addrCol.find().toArray()).map((d) => this.strip<DepositAddress>(d));
  }
  async saveAddress(a: DepositAddress): Promise<void> {
    if (!this.addrCol) return;
    await this.addrCol.replaceOne({ _id: a.id }, { ...a }, { upsert: true });
  }
  async deleteAddress(id: string): Promise<void> {
    if (!this.addrCol) return;
    await this.addrCol.deleteOne({ _id: id });
  }
}
