import { Injectable, Logger } from '@nestjs/common';
import { MongoService } from '../db/mongo.service';
import { PaymentStore } from './payment-store';

/* ============================================================
   ДОСТУП ДО СХОВИЩА — одне підключення на всі сервіси платежів.

   Заявки, адреси прийому й неопізнані перекази живуть у трьох різних
   сервісах, але в одній базі. Кожен міг би відкрити собі власний
   PaymentStore, і працювало б це так само — але тоді «чи є взагалі
   база» вирішувалось би в трьох місцях по-різному, а порядок
   завантаження залежав би від порядку створення провайдерів.

   Тут воно одне, і чекати на нього треба ЯВНО: `await ready()`.

   Раніше сховище піднімалось у власному onModuleInit, з розрахунку на
   те, що Nest викличе його раніше за тих, хто цей провайдер інжектить.
   Це неправда: хуки onModuleInit усіх провайдерів модуля запускаються
   через Promise.all, тобто ОДНОЧАСНО. Поки тут ішло `await mongo.ready()`,
   сусіди вже читали `get()` і отримували null — і стартували порожніми
   при повній базі. Найпомітніше це було на адресах прийому: пул порожній
   -> будь-який депозит падав у «Эта сеть временно недоступна».

   null — нормальний стан, а не помилка: без MONGO_URL сервер працює
   в пам'яті, і всі записи просто нікуди не зберігаються.
   ============================================================ */

@Injectable()
export class PaymentStoreRef {
  private readonly log = new Logger(PaymentStoreRef.name);
  private store: PaymentStore | null = null;
  private opening: Promise<PaymentStore | null> | null = null;

  constructor(private readonly mongo: MongoService) {}

  /* Сховище, коли воно буде. Підключення одне на всіх: перший, хто
     спитав, запускає його, решта чекає на той самий проміс. */
  ready(): Promise<PaymentStore | null> {
    if (!this.opening) {
      this.opening = this.mongo.ready().then((db) => {
        this.store = db ? new PaymentStore(db) : null;
        return this.store;
      });
    }
    return this.opening;
  }

  /* Синхронний доступ для запису — тим, хто вже дочекався ready().
     До того повертає null, і запис просто нікуди не піде, тому в
     onModuleInit беруть саме ready(), а не це. */
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
