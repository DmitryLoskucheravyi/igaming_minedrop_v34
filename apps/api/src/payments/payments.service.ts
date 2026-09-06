import {
  BadRequestException, ConflictException, Inject, Injectable, Logger,
  NotFoundException, type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../config/env';
import { RatesService } from '../rates/rates.service';
import { PlayersService } from '../players/players.service';
import { PaymentStore } from './payment-store';
import {
  PAYMENT_MAX_RUB, PAYMENT_MIN_RUB, PAYMENT_TTL_MS,
  type DepositAddress, type PaymentMethod, type PaymentRecord,
} from './payment.types';

/* Адреса TRC20: T + 33 base58. Перевірка м'яка — рівно щоб відсіяти
   очевидне сміття, а не валідувати чексуму. */
const TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PaymentsService.name);
  private readonly items = new Map<string, PaymentRecord>();
  private readonly addrs = new Map<string, DepositAddress>();
  private store: PaymentStore | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly rates: RatesService,
    private readonly players: PlayersService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.mongoUrl) {
      const store = new PaymentStore();
      try {
        await store.connect(this.env.mongoUrl);
        for (const p of await store.loadAll()) this.items.set(p.id, p);
        for (const a of await store.loadAddresses()) this.addrs.set(a.id, a);
        this.store = store;
        this.log.log(`Завантажено: заявок ${this.items.size}, адрес ${this.addrs.size}`);
      } catch (e) {
        await store.close();
        this.log.error(`MongoDB (payments) недоступна: ${(e as Error).message}`);
        if (this.env.isProd) throw e;
      }
    }

    // сід із env: якщо адрес нема, а в конфізі задана валідна — заводимо
    const seed = this.env.usdtTrc20Address;
    if (seed && TRC20_RE.test(seed) && !this.addrList().some((a) => a.address === seed)) {
      this.addAddress(seed, 'из .env');
    }

    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweep();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.store?.close();
  }

  private persist(rec: PaymentRecord): void {
    this.store?.save(rec).catch((e) =>
      this.log.error(`не зберіглась заявка ${rec.id}: ${(e as Error).message}`));
  }
  private persistAddr(a: DepositAddress): void {
    this.store?.saveAddress(a).catch((e) =>
      this.log.error(`не зберіглась адреса ${a.id}: ${(e as Error).message}`));
  }

  private sweep(): void {
    const now = Date.now();
    for (const p of this.items.values()) {
      if (p.status === 'pending' && now > p.expiresAt) {
        p.status = 'expired';
        p.resolvedAt = now;
        this.persist(p);
        this.log.warn(`заявка ${p.id} протухла (${p.telegramId}, ${p.amount}₽)`);
      }
    }
  }

  /* ---- адреси ---- */

  addrList(): DepositAddress[] {
    return [...this.addrs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  addAddress(address: string, label?: string): DepositAddress {
    const addr = address.trim();
    if (!TRC20_RE.test(addr)) throw new BadRequestException('Не похоже на адрес TRC20 (T + 33 символа)');
    if (this.addrList().some((a) => a.address === addr)) {
      throw new ConflictException('Такой адрес уже есть');
    }
    const a: DepositAddress = {
      id: randomUUID(), address: addr, active: true, createdAt: Date.now(),
      label: label?.trim().slice(0, 60) || undefined,
    };
    this.addrs.set(a.id, a);
    this.persistAddr(a);
    return a;
  }

  updateAddress(id: string, patch: { label?: string; active?: boolean }): DepositAddress {
    const a = this.addrs.get(id);
    if (!a) throw new NotFoundException('Адрес не найден');
    if (patch.label !== undefined) a.label = patch.label.trim().slice(0, 60) || undefined;
    if (patch.active !== undefined) a.active = patch.active;
    this.persistAddr(a);
    return a;
  }

  removeAddress(id: string): void {
    if (!this.addrs.delete(id)) throw new NotFoundException('Адрес не найден');
    this.store?.deleteAddress(id).catch((e) =>
      this.log.error(`не видалилась адреса ${id}: ${(e as Error).message}`));
  }

  /** скільки pending-заявок висить на кожній адресі */
  private pendingByAddr(): Map<string, number> {
    const m = new Map<string, number>();
    for (const p of this.items.values()) {
      if (p.status === 'pending' && p.addressId) m.set(p.addressId, (m.get(p.addressId) ?? 0) + 1);
    }
    return m;
  }

  /** Вибрати адресу для нової заявки: активну, по можливості без
      жодної pending-заявки; інакше з найменшою кількістю. */
  private pickAddress(): DepositAddress {
    const active = this.addrList().filter((a) => a.active);
    if (!active.length) throw new BadRequestException('Депозит временно недоступен');
    const busy = this.pendingByAddr();
    return active.sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))[0];
  }

  /* ---- заявки ---- */

  activeFor(telegramId: number): PaymentRecord | undefined {
    this.sweep();
    return [...this.items.values()].find(
      (p) => p.telegramId === telegramId && p.status === 'pending');
  }

  create(telegramId: number, amount: number, method: PaymentMethod): PaymentRecord {
    if (method !== 'usdt_trc20') throw new BadRequestException('Способ не поддерживается');
    if (!Number.isFinite(amount) || amount < PAYMENT_MIN_RUB || amount > PAYMENT_MAX_RUB) {
      throw new BadRequestException(`Сумма должна быть от ${PAYMENT_MIN_RUB} до ${PAYMENT_MAX_RUB} ₽`);
    }
    if (this.activeFor(telegramId)) {
      throw new ConflictException('У вас уже есть активная заявка — дождитесь её завершения');
    }

    const addr = this.pickAddress();
    const rate = this.rates.snapshot().rubPerUsdt;
    const usdtAmount = Math.round((amount / rate) * 10000) / 10000;
    const now = Date.now();
    const rec: PaymentRecord = {
      id: randomUUID(),
      telegramId,
      method,
      amount: Math.round(amount),
      usdtAmount,
      rate,
      address: addr.address,
      addressId: addr.id,
      status: 'pending',
      createdAt: now,
      expiresAt: now + PAYMENT_TTL_MS,
    };
    this.items.set(rec.id, rec);
    this.persist(rec);
    this.log.log(`нова заявка ${rec.id}: ${telegramId} ${amount}₽ (${usdtAmount} USDT) -> ${addr.address}`);
    return rec;
  }

  listForPlayer(telegramId: number): PaymentRecord[] {
    this.sweep();
    return [...this.items.values()]
      .filter((p) => p.telegramId === telegramId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listAll(): PaymentRecord[] {
    this.sweep();
    const rank = (s: PaymentRecord['status']) => (s === 'pending' ? 0 : 1);
    return [...this.items.values()].sort(
      (a, b) => rank(a.status) - rank(b.status) || b.createdAt - a.createdAt);
  }

  approve(id: string): PaymentRecord {
    const rec = this.mustPending(id);
    rec.status = 'approved';
    rec.resolvedAt = Date.now();
    this.persist(rec);
    const balance = this.players.topUp(rec.telegramId, rec.amount);
    this.log.log(`заявку ${id} погоджено: ${rec.telegramId} +${rec.amount}₽ -> ${balance}`);
    return rec;
  }

  reject(id: string, note?: string): PaymentRecord {
    const rec = this.mustPending(id);
    rec.status = 'rejected';
    rec.resolvedAt = Date.now();
    if (note) rec.adminNote = note.slice(0, 300);
    this.persist(rec);
    this.log.warn(`заявку ${id} скасовано адміном`);
    return rec;
  }

  private mustPending(id: string): PaymentRecord {
    this.sweep();
    const rec = this.items.get(id);
    if (!rec) throw new NotFoundException('Заявка не найдена');
    if (rec.status !== 'pending') {
      throw new ConflictException(`Заявка уже в статусе «${rec.status}»`);
    }
    return rec;
  }
}
