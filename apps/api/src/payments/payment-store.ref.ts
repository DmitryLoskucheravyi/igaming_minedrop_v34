import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { MongoService } from '../db/mongo.service';
import { PaymentStore } from './payment-store';

/* ============================================================
   ДОСТУП ДО СХОВИЩА — одне підключення на всі сервіси платежів.

   Заявки, адреси прийому й неопізнані перекази живуть у трьох різних
   сервісах, але в одній базі. Кожен міг би відкрити собі власний
   PaymentStore, і працювало б це так само — але тоді «чи є взагалі
   база» вирішувалось би в трьох місцях по-різному, а порядок
   завантаження залежав би від порядку створення провайдерів.

   Тут воно одне: Nest підіймає цей провайдер ПЕРЕД тими, хто його
   інжектить, тож на момент їхнього onModuleInit сховище вже готове.

   null — нормальний стан, а не помилка: без MONGO_URL сервер працює
   в пам'яті, і всі записи просто нікуди не зберігаються.
   ============================================================ */

@Injectable()
export class PaymentStoreRef implements OnModuleInit {
  private readonly log = new Logger(PaymentStoreRef.name);
  private store: PaymentStore | null = null;

  constructor(private readonly mongo: MongoService) {}

  async onModuleInit(): Promise<void> {
    const db = await this.mongo.ready();
    if (db) this.store = new PaymentStore(db);
  }

  get(): PaymentStore | null {
    return this.store;
  }

  /* Запис «як вийде»: помилка потрапляє в лог, а не зриває дію, яка
     вже сталася в пам'яті. Це свідомий компроміс схеми «істина в
     пам'яті, база — дзеркало», і саме тому кожен збій запису має бути
     видно в логах: розходження пам'яті й бази інакше не помітити. */
  save(what: string, p: Promise<unknown> | undefined): void {
    p?.catch((e: unknown) =>
      this.log.error(`не збереглось (${what}): ${(e as Error).message}`));
  }
}
