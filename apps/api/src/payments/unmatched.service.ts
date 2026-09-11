import {
  BadRequestException, ConflictException, Injectable, Logger,
  NotFoundException, type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RatesService } from '../rates/rates.service';
import { PlayersService } from '../players/players.service';
import { PaymentStoreRef } from './payment-store.ref';
import type { IncomingTx } from './payment.types';
import type { UnmatchedPayment, UnmatchedStatus } from './unmatched.types';

/* ============================================================
   НЕОПІЗНАНІ ПЕРЕКАЗИ.

   Гроші прийшли, а заявки під них немає: сума не зійшлась, коментаря
   не було, переказ виглядає підозріло. Викинути їх не можна — вони вже
   в нас і належать живій людині, — а зарахувати автоматично нікому.

   Тому окремий журнал, який поповнюється В БУДЬ-ЯКОМУ режимі бота:
   заявка протухає за тридцять хвилин, а гроші в мережі не протухають
   ніколи. Далі їх розбирає адмін руками.
   ============================================================ */

@Injectable()
export class UnmatchedRegistry implements OnModuleInit {
  private readonly log = new Logger(UnmatchedRegistry.name);
  private readonly rows = new Map<string, UnmatchedPayment>();

  constructor(
    private readonly store: PaymentStoreRef,
    private readonly rates: RatesService,
    private readonly players: PlayersService,
  ) {}

  async onModuleInit(): Promise<void> {
    const s = await this.store.ready();
    if (s) {
      for (const u of await s.loadUnmatched()) this.rows.set(u.id, u);
      this.log.log(`Завантажено неопізнаних: ${this.rows.size}`);
    }
  }

  private persist(u: UnmatchedPayment): void {
    this.store.save(`неопізнаний ${u.id}`, this.store.get()?.saveUnmatched(u));
  }

  list(): UnmatchedPayment[] {
    const rank = (st: UnmatchedStatus) => (st === 'new' ? 0 : 1);
    return [...this.rows.values()].sort(
      (a, b) => rank(a.status) - rank(b.status) || b.at - a.at);
  }

  hasTxid(txid: string): boolean {
    const t = txid.toLowerCase();
    for (const u of this.rows.values()) if (u.txid.toLowerCase() === t) return true;
    return false;
  }

  /** Покласти переказ у журнал із поясненням, ЧОМУ він не зіставився. */
  add(tx: IncomingTx, reason: string): UnmatchedPayment {
    const row: UnmatchedPayment = {
      id: randomUUID(),
      network: tx.network, token: tx.token,
      address: tx.to, from: tx.from, amount: tx.amount,
      txid: tx.txid, at: tx.at, memo: tx.memo,
      status: 'new', seenAt: Date.now(),
      adminNote: reason,
    };
    this.rows.set(row.id, row);
    this.persist(row);
    this.log.warn(`неопізнаний переказ ${tx.amount} ${tx.token.toUpperCase()} ` +
      `у ${tx.network} на ${tx.to} (${reason}), txid ${tx.txid}`);
    return row;
  }

  private mustNew(id: string): UnmatchedPayment {
    const u = this.rows.get(id);
    if (!u) throw new NotFoundException('Платёж не найден');
    if (u.status !== 'new') throw new ConflictException(`Платёж уже в статусе «${u.status}»`);
    return u;
  }

  /* Ручне зарахування неопізнаного переказу вибраному гравцю.

     Якщо суму в ₽ не задали, рахуємо за ПОТОЧНИМ курсом: курсу на
     момент переказу ми не знаємо, заявки ж не було. Адмін бачить
     підрахунок і може задати суму сам. Порядок той самий, що в
     approve(): спершу гроші, потім статус. */
  credit(id: string, telegramId: number, rub?: number): UnmatchedPayment {
    const u = this.mustNew(id);
    const amount = Math.round(rub ?? u.amount * this.rates.snapshot().rubPerUsdt);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Сумма зачисления должна быть больше нуля');
    }

    const balance = this.players.topUp(telegramId, amount);
    if (balance === null) throw new NotFoundException(`Игрок ${telegramId} не найден`);

    u.status = 'credited';
    u.creditedTo = telegramId;
    u.creditedRub = amount;
    u.resolvedAt = Date.now();
    this.persist(u);
    this.log.log(`неопізнаний ${id} зараховано: ${telegramId} +${amount}₽ -> ${balance}`);
    return u;
  }

  ignore(id: string, note?: string): UnmatchedPayment {
    const u = this.mustNew(id);
    u.status = 'ignored';
    u.resolvedAt = Date.now();
    if (note) u.adminNote = note.slice(0, 300);
    this.persist(u);
    return u;
  }
}
