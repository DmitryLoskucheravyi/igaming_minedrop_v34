import {
  BadRequestException, ConflictException, Inject, Injectable, Logger,
  NotFoundException, type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../config/env';
import { SettingsService } from '../settings/settings.service';
import { PaymentStoreRef } from './payment-store.ref';
import type { DepositAddress, WatchTarget } from './payment.types';
import { NETWORKS, TOKENS, isValidAddress, type Family } from './networks';

/* ============================================================
   ПУЛ АДРЕС ПРИЙОМУ.

   Адреси заводяться на РОДИНУ, а не на мережу: одна 0x-адреса приймає
   в усіх шести EVM-мережах одразу, тож ділити її по мережах нема сенсу.

   Тут же живе те, що з цих адрес бачить спостерігач (watchTargets):
   список формується на льоту з поточних адрес і поточних налаштувань,
   тому власної копії в спостерігача немає й розсинхрону теж.

   Про заявки цей сервіс не знає НІЧОГО — і це навмисно. Щоб вибрати
   найменш завантажену адресу, йому передають готову мапу зайнятості
   (pick), а не інжектять сервіс заявок: інакше вийшло б кільце
   «адреси -> заявки -> адреси», яке Nest розв'язує лише forwardRef, а
   читач — ніяк.
   ============================================================ */

@Injectable()
export class DepositAddressPool implements OnModuleInit {
  private readonly log = new Logger(DepositAddressPool.name);
  private readonly addrs = new Map<string, DepositAddress>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly store: PaymentStoreRef,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const s = await this.store.ready();
    if (s) {
      for (const a of await s.loadAddresses()) this.addrs.set(a.id, a);
      this.log.log(`Завантажено адрес: ${this.addrs.size}`);
    }

    // сід із env: якщо адрес нема, а в конфізі задана валідна — заводимо
    const seed = this.env.usdtTrc20Address;
    if (seed && isValidAddress('tron', seed) && !this.list().some((a) => a.address === seed)) {
      this.add('tron', seed, 'из .env');
    }
  }

  private persist(a: DepositAddress): void {
    this.store.save(`адреса ${a.id}`, this.store.get()?.saveAddress(a));
  }

  list(): DepositAddress[] {
    return [...this.addrs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  add(family: Family, address: string, label?: string): DepositAddress {
    const addr = address.trim();
    if (!isValidAddress(family, addr)) {
      throw new BadRequestException('Адрес не подходит под формат этой сети');
    }
    if (this.list().some((a) => a.address === addr && a.family === family)) {
      throw new ConflictException('Такой адрес уже есть');
    }
    const now = Date.now();
    /* watchFrom = момент додавання. Гаманець може бути не порожній, і
       без цієї межі спостерігач підняв би всю його минулу історію. */
    const a: DepositAddress = {
      id: randomUUID(), address: addr, family, active: true,
      createdAt: now, watchFrom: now,
      label: label?.trim().slice(0, 60) || undefined,
    };
    this.addrs.set(a.id, a);
    this.persist(a);
    return a;
  }

  update(id: string, patch: { label?: string; active?: boolean }): DepositAddress {
    const a = this.addrs.get(id);
    if (!a) throw new NotFoundException('Адрес не найден');
    if (patch.label !== undefined) a.label = patch.label.trim().slice(0, 60) || undefined;
    if (patch.active !== undefined) a.active = patch.active;
    this.persist(a);
    return a;
  }

  remove(id: string): void {
    if (!this.addrs.delete(id)) throw new NotFoundException('Адрес не найден');
    this.store.save(`видалення адреси ${id}`, this.store.get()?.deleteAddress(id));
  }

  /* Прогрес спостерігача по адресі. Лежить біля самої адреси, а не в
     пам'яті спостерігача: після рестарту він має продовжити з того ж
     місця, а не перечитувати все заново. */
  noteScan(id: string, cursor?: string): void {
    const a = this.addrs.get(id);
    if (!a) return;
    a.scannedAt = Date.now();
    if (cursor !== undefined) a.cursor = cursor;
    this.persist(a);
  }

  /* Що слухати ПРОСТО ЗАРАЗ.

     Спостерігач викликає це кожен цикл, а не читає список один раз на
     старті. Тому адреса, додана хвилину тому, вже в роботі; вимкнена —
     вже ні; вимкнули мережу в CRM — перестали її дивитись. Жодного
     рестарту, жодної копії списку на боці спостерігача.

     Режим off повертає порожньо: це і є «бот не слухає взагалі». */
  watchTargets(): WatchTarget[] {
    const cfg = this.settings.getDeposits();
    /* Два різні «ні»: рубильник вимкнено або боту не довіряють нічого.
       Обидва означають одне — не ходити в мережу зовсім. */
    if (!cfg.enabled || cfg.mode === 'off') return [];

    const tokens = cfg.tokens.filter((t) => !!TOKENS[t]);
    if (!tokens.length) return [];

    return this.list()
      .filter((a) => a.active)
      .map((a) => {
        /* Мережі цієї родини, які зараз увімкнені І в яких є хоч одна
           з увімкнених монет. Слухати мережу, де нічого не приймаємо,
           означало б витрачати ліміт API даремно. */
        const networks = cfg.networks.filter((id) =>
          NETWORKS[id]?.family === a.family &&
          tokens.some((t) => !!NETWORKS[id].tokens[t]));
        return {
          addressId: a.id, address: a.address, family: a.family, label: a.label,
          watchFrom: a.watchFrom ?? a.createdAt,
          cursor: a.cursor, scannedAt: a.scannedAt,
          networks,
          tokens: tokens.filter((t) => networks.some((id) => !!NETWORKS[id].tokens[t])),
        };
      })
      .filter((t) => t.networks.length > 0);
  }

  /** Підпис адреси для CRM: у таблиці заявок хеші очима не звіряють. */
  labelOf(addressId?: string): string | null {
    return (addressId && this.addrs.get(addressId)?.label) || null;
  }

  /* Адреса під нову заявку: потрібної РОДИНИ, активна, по можливості
     без жодної відкритої заявки; інакше з найменшою їх кількістю.
     Зайнятість приходить ззовні — див. коментар до класу. */
  pick(family: Family, busy: Map<string, number>): DepositAddress {
    const active = this.list().filter((a) => a.active && a.family === family);
    if (!active.length) {
      throw new BadRequestException('Эта сеть временно недоступна — нет адреса приёма');
    }
    return active.sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))[0];
  }
}
