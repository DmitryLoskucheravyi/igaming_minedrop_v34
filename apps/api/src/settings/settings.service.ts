import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Collection, type Db } from 'mongodb';
import { MongoService } from '../db/mongo.service';
import { DEFAULT_DEPOSIT_SETTINGS, type DepositSettings } from './settings.types';

/* Налаштування, які адмін міняє на ходу. Один документ на розділ:
   колекція `settings`, _id — назва розділу. У процесі тримаємо копію,
   бо читають їх часто (кожне вікно поповнення), а міняють рідко. */

type Stored = DepositSettings & { _id: string };

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly log = new Logger(SettingsService.name);
  private col: Collection<Stored> | null = null;
  private deposits: DepositSettings = { ...DEFAULT_DEPOSIT_SETTINGS };

  constructor(private readonly mongo: MongoService) {}

  async onModuleInit(): Promise<void> {
    const db: Db | null = await this.mongo.ready();
    if (!db) return;
    this.col = db.collection<Stored>('settings');
    const doc = await this.col.findOne({ _id: 'deposits' });
    if (doc) {
      const { _id, ...rest } = doc;
      void _id;
      /* Розкладаємо поверх дефолтів: у старому документі може не бути
         поля, доданого пізніше, і без цього воно стало б undefined. */
      this.deposits = { ...DEFAULT_DEPOSIT_SETTINGS, ...rest };
    }
    this.log.log(`Прийом: режим ${this.deposits.mode}, мережі ${this.deposits.networks.join(', ')}`);
  }

  getDeposits(): DepositSettings {
    return this.deposits;
  }

  /* Патч часткова річ: CRM шле лише те, що змінилось. Ключі зі
     значенням undefined треба ВИКИНУТИ, а не розкласти поверх — інакше
     `{ mode: 'watch' }` від валідатора приїде як
     `{ mode: 'watch', networks: undefined, tokens: undefined }` і зітре
     списки мереж та монет. Тобто зміна режиму мовчки вимикала б прийом. */
  async setDeposits(patch: Partial<DepositSettings>): Promise<DepositSettings> {
    const clean = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ) as Partial<DepositSettings>;
    this.deposits = { ...this.deposits, ...clean };
    await this.col?.replaceOne(
      { _id: 'deposits' },
      { ...this.deposits } as Stored,
      { upsert: true },
    ).catch((e: Error) => this.log.error(`не зберіглись налаштування: ${e.message}`));
    this.log.warn(`Прийом змінено: режим ${this.deposits.mode}, ` +
      `мережі ${this.deposits.networks.join(', ') || '—'}, ` +
      `токени ${this.deposits.tokens.join(', ') || '—'}`);
    return this.deposits;
  }
}
