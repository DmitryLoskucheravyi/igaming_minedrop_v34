import {
  BadRequestException, ConflictException, Injectable, Logger,
  NotFoundException, type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MongoService } from '../db/mongo.service';
import { RatesService } from '../rates/rates.service';
import { PlayersService } from '../players/players.service';
import { WithdrawStore } from './withdraw-store';
import {
  WITHDRAW_MAX_RUB, WITHDRAW_MIN_RUB,
  type WithdrawMethod, type WithdrawRecord,
} from './withdraw.types';

/* Адреса TRC20: T + 33 base58. Та сама м'яка перевірка, що й для адрес
   прийому — відсіює очевидне сміття, чексуму не рахує. */
const TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

@Injectable()
export class WithdrawService implements OnModuleInit {
  private readonly log = new Logger(WithdrawService.name);
  private readonly items = new Map<string, WithdrawRecord>();
  private store: WithdrawStore | null = null;

  constructor(
    private readonly mongo: MongoService,
    private readonly rates: RatesService,
    private readonly players: PlayersService,
  ) {}

  async onModuleInit(): Promise<void> {
    const db = await this.mongo.ready();
    if (!db) return;
    const store = new WithdrawStore(db);
    for (const w of await store.loadAll()) this.items.set(w.id, w);
    this.store = store;
    this.log.log(`Завантажено заявок на виведення: ${this.items.size}`);
  }

  private persist(rec: WithdrawRecord): void {
    this.store?.save(rec).catch((e) =>
      this.log.error(`не зберіглась заявка на виведення ${rec.id}: ${(e as Error).message}`));
  }

  /* ---- гравець ---- */

  activeFor(telegramId: number): WithdrawRecord | undefined {
    return [...this.items.values()].find(
      (w) => w.telegramId === telegramId && w.status === 'pending');
  }

  listForPlayer(telegramId: number): WithdrawRecord[] {
    return [...this.items.values()]
      .filter((w) => w.telegramId === telegramId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Створити заявку. Баланс списується ТУТ, а не при погодженні —
      див. коментар у withdraw.types.ts. */
  create(telegramId: number, amount: number, addressRaw: string,
         method: WithdrawMethod): WithdrawRecord {
    if (method !== 'usdt_trc20') throw new BadRequestException('Способ не поддерживается');

    const value = Math.round(amount);
    if (!Number.isFinite(value) || value < WITHDRAW_MIN_RUB || value > WITHDRAW_MAX_RUB) {
      throw new BadRequestException(
        `Сумма должна быть от ${WITHDRAW_MIN_RUB} до ${WITHDRAW_MAX_RUB} ₽`);
    }

    const address = addressRaw.trim();
    if (!TRC20_RE.test(address)) {
      throw new BadRequestException('Не похоже на адрес TRC20 (T + 33 символа)');
    }

    /* Одна активна заявка на гравця — як і в депозиті. Інакше можна
       нарізати баланс на десяток заявок і завалити ними CRM. */
    if (this.activeFor(telegramId)) {
      throw new ConflictException('У вас уже есть заявка на вывод — дождитесь её обработки');
    }

    /* СПИСУЄМО ОДРАЗУ. Якщо не вистачає — заявки не буде взагалі. */
    const charged = this.players.charge(telegramId, value, 'вивід');
    if (!charged.ok) {
      throw charged.reason === 'no-player'
        ? new NotFoundException('Игрок не найден')
        : new BadRequestException('Недостаточно средств на балансе');
    }

    const rate = this.rates.snapshot().rubPerUsdt;
    const rec: WithdrawRecord = {
      id: randomUUID(),
      telegramId,
      method,
      amount: value,
      usdtAmount: Math.round((value / rate) * 10000) / 10000,
      rate,
      rateApprox: this.rates.isApproximate(),
      address,
      status: 'pending',
      createdAt: Date.now(),
    };
    this.items.set(rec.id, rec);
    this.persist(rec);
    this.log.log(`заявка на вивід ${rec.id}: ${telegramId} -${value}₽ ` +
      `(${rec.usdtAmount} USDT) -> ${address}. Баланс: ${charged.balance}`);
    return rec;
  }

  /** Гравець передумав. Гроші повертаються. */
  cancel(telegramId: number, id: string): WithdrawRecord {
    const rec = this.items.get(id);
    if (!rec || rec.telegramId !== telegramId) throw new NotFoundException('Заявка не найдена');
    return this.refund(rec, 'canceled', 'гравець скасував');
  }

  /* ---- CRM ---- */

  listAll(): WithdrawRecord[] {
    const rank = (s: WithdrawRecord['status']) => (s === 'pending' ? 0 : 1);
    return [...this.items.values()].sort(
      (a, b) => rank(a.status) - rank(b.status) || b.createdAt - a.createdAt);
  }

  /** Кошти відправлено. Баланс НЕ чіпаємо — його вже списано при
      створенні заявки. */
  approve(id: string): WithdrawRecord {
    const rec = this.mustPending(id);
    rec.status = 'approved';
    rec.resolvedAt = Date.now();
    this.persist(rec);
    this.log.log(`вивід ${id} погоджено: ${rec.telegramId} ${rec.usdtAmount} USDT -> ${rec.address}`);
    return rec;
  }

  /** Відмова. Гроші повертаються на баланс. */
  reject(id: string, note?: string): WithdrawRecord {
    const rec = this.mustPending(id);
    return this.refund(rec, 'rejected', 'адмін відхилив', note);
  }

  /* Повернення резерву. Єдине місце, де гроші їдуть назад, і воно
     захищене перевіркою статусу: заявка виходить із pending рівно один
     раз, тож повернути двічі не вийде. */
  private refund(rec: WithdrawRecord, status: 'rejected' | 'canceled',
                 why: string, note?: string): WithdrawRecord {
    if (rec.status !== 'pending') {
      throw new ConflictException(`Заявка уже в статусе «${rec.status}»`);
    }
    const balance = this.players.topUp(rec.telegramId, rec.amount, 'повернення виводу');
    if (balance === null) {
      /* Гравця немає — повертати нікуди. Лишаємо pending, щоб гроші не
         зникли мовчки: адмін побачить заявку й розбереться вручну. */
      throw new NotFoundException(
        `Игрок ${rec.telegramId} не найден — средства не возвращены, заявка осталась в ожидании`);
    }
    rec.status = status;
    rec.resolvedAt = Date.now();
    if (note) rec.adminNote = note.slice(0, 300);
    this.persist(rec);
    this.log.warn(`вивід ${rec.id} (${why}): повернено ${rec.amount}₽ -> ${balance}`);
    return rec;
  }

  private mustPending(id: string): WithdrawRecord {
    const rec = this.items.get(id);
    if (!rec) throw new NotFoundException('Заявка не найдена');
    if (rec.status !== 'pending') {
      throw new ConflictException(`Заявка уже в статусе «${rec.status}»`);
    }
    return rec;
  }
}
