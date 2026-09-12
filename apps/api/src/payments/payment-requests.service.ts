import {
  BadRequestException, ConflictException, Injectable, Logger,
  NotFoundException, type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RatesService } from '../rates/rates.service';
import { PlayersService } from '../players/players.service';
import { SettingsService } from '../settings/settings.service';
import { PaymentStoreRef } from './payment-store.ref';
import { ReferralsService } from '../referrals/referrals.service';
import { PromosService } from '../promos/promos.service';
import { DepositAddressPool } from './deposit-addresses.service';
import {
  MEMO_STEPS, MEMO_UNIT, PAYMENT_MAX_RUB, PAYMENT_MIN_RUB, PAYMENT_TTL_MS,
  type PaymentRecord, type ResolvedBy,
} from './payment.types';
import { NETWORKS, type NetworkId, type TokenId } from './networks';

/* ============================================================
   ЗАЯВКИ НА ПОПОВНЕННЯ — життєвий цикл однієї заявки.

   Створити, показати, погодити, відхилити, дати гравцю зняти свою,
   протухнути за 30 хвилин. Усе, що стосується ПЕРЕКАЗІВ у мережі
   (зіставлення, дозрівання, неопізнані), живе окремо — у
   TransferMatcher і UnmatchedRegistry: тут про блокчейн не знають
   нічого, крім того, що заявці колись проставлять txid.

   «Заявка ще жива» — це pending АБО processing. Скрізь, де раніше
   стояло `status === 'pending'`, має стояти isOpen: інакше заявка в
   processing перестане займати свій дріб суми, і наступна заявка на ту
   саму адресу отримає такий самий «хвостик». Два відкриті рахунки з
   однаковою сумою на одній адресі — це рівно те, від чого дріб рятує.
   ============================================================ */

const isOpen = (p: PaymentRecord): boolean =>
  p.status === 'pending' || p.status === 'processing';

@Injectable()
export class PaymentRequests implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PaymentRequests.name);
  private readonly items = new Map<string, PaymentRecord>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: PaymentStoreRef,
    private readonly rates: RatesService,
    private readonly players: PlayersService,
    private readonly settings: SettingsService,
    private readonly addresses: DepositAddressPool,
    private readonly referrals: ReferralsService,
    private readonly promos: PromosService,
  ) {}

  async onModuleInit(): Promise<void> {
    const s = await this.store.ready();
    if (s) {
      for (const p of await s.loadAll()) this.items.set(p.id, p);
      this.log.log(`Завантажено заявок: ${this.items.size}`);
    }
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweep();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  persist(rec: PaymentRecord): void {
    this.store.save(`заявка ${rec.id}`, this.store.get()?.save(rec));
  }

  /* Протухає ТІЛЬКИ pending. Заявка в processing уже оплачена — гроші
     в мережі, і зняти їх назад не можна; протухнути їй означало б
     втратити переказ, який ми самі й знайшли. */
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

  /* ---- читання ---- */

  /* Активна заявка гравця. Заявка в processing теж активна: гравець
     уже переказав, і показати йому «заявок немає» означало б спонукати
     переказати вдруге. */
  activeFor(telegramId: number): PaymentRecord | undefined {
    this.sweep();
    return [...this.items.values()].find(
      (p) => p.telegramId === telegramId && isOpen(p));
  }

  listForPlayer(telegramId: number): PaymentRecord[] {
    this.sweep();
    return [...this.items.values()]
      .filter((p) => p.telegramId === telegramId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listAll(): PaymentRecord[] {
    this.sweep();
    /* Угорі те, що ще живе: спершу оплачені (їх чекає рішення), далі
       ті, що чекають переказу, далі закриті. */
    const rank = (s: PaymentRecord['status']) =>
      s === 'processing' ? 0 : s === 'pending' ? 1 : 2;
    return [...this.items.values()].sort(
      (a, b) => rank(a.status) - rank(b.status) || b.createdAt - a.createdAt);
  }

  get(id: string): PaymentRecord | undefined {
    return this.items.get(id);
  }

  /** Заявки, які ще чекають переказу — робочий набір зіставлення. */
  pendingList(): PaymentRecord[] {
    return [...this.items.values()].filter((p) => p.status === 'pending');
  }

  /** Заявки, які лежать у processing і чекають перевірки в мережі. */
  processingList(): PaymentRecord[] {
    return [...this.items.values()].filter((p) => p.status === 'processing');
  }

  hasTxid(txid: string): boolean {
    const t = txid.toLowerCase();
    for (const p of this.items.values()) if (p.txid?.toLowerCase() === t) return true;
    return false;
  }

  /** Скільки відкритих заявок висить на кожній адресі. */
  busyByAddress(): Map<string, number> {
    const m = new Map<string, number>();
    for (const p of this.items.values()) {
      if (isOpen(p) && p.addressId) m.set(p.addressId, (m.get(p.addressId) ?? 0) + 1);
    }
    return m;
  }

  /** Курс, за яким порахується заявка, якщо створити її просто зараз. */
  currentRate(): { rubPerUsdt: number; approx: boolean } {
    return { rubPerUsdt: this.rates.snapshot().rubPerUsdt, approx: this.rates.isApproximate() };
  }

  /* ---- створення ---- */

  /* Дріб, якого зараз немає в жодної відкритої заявки на цю адресу.
     Саме він робить пару «адреса + сума» унікальною. Якщо всі сто
     варіантів зайняті (це означало б сотню одночасних заявок на одну
     адресу), беремо випадковий: гірше зіставлення краще, ніж відмова
     створити заявку. */
  private freeMemoUnit(addressId: string): number {
    const taken = new Set<number>();
    for (const p of this.items.values()) {
      if (isOpen(p) && p.addressId === addressId) {
        taken.add(Math.round((p.usdtAmount - Math.floor(p.usdtAmount * 100) / 100) / MEMO_UNIT));
      }
    }
    for (let i = 1; i <= MEMO_STEPS; i++) if (!taken.has(i)) return i;
    return 1 + Math.floor(Math.random() * MEMO_STEPS);
  }

  create(telegramId: number, amount: number, network: NetworkId, token: TokenId,
         promoCode?: string): PaymentRecord {
    const cfg = this.settings.getDeposits();
    const net = NETWORKS[network];
    if (!net || !cfg.networks.includes(network)) {
      throw new BadRequestException('Эта сеть сейчас недоступна');
    }
    if (!cfg.tokens.includes(token) || !net.tokens[token]) {
      throw new BadRequestException(`${token.toUpperCase()} в этой сети не принимается`);
    }
    if (!Number.isFinite(amount) || amount < PAYMENT_MIN_RUB || amount > PAYMENT_MAX_RUB) {
      throw new BadRequestException(`Сумма должна быть от ${PAYMENT_MIN_RUB} до ${PAYMENT_MAX_RUB} ₽`);
    }
    if (this.activeFor(telegramId)) {
      throw new ConflictException('У вас уже есть активная заявка — дождитесь её завершения');
    }

    /* Промокод перевіряємо ДО видачі адреси й до всіх розрахунків.
       Невідомий код кидає — саме тому, що гравець вписав його свідомо:
       мовчки створити заявку без надбавки означало б забрати в нього
       гроші, про які він домовлявся. Хай краще виправить друкарську
       помилку зараз, ніж прийде зі скаргою після переказу. */
    const promo = this.promos.percentFor(promoCode);

    const addr = this.addresses.pick(net.family, this.busyByAddress());
    const rate = this.rates.snapshot().rubPerUsdt;
    /* Курс міг не приїхати з біржі — тоді працює fallback, і сума USDT
       нижче лише приблизна. Мовчати про це не можна: людина переказує
       реальні кошти. Позначаємо заявку, а показують це і гравцю
       (DepositModal), і адміну в CRM. */
    const rateApprox = this.rates.isApproximate();

    /* Сума з унікальним «хвостиком». Округлюємо ВНИЗ до копійки й
       дописуємо власний дріб — так пара «адреса + сума» вказує рівно на
       цю заявку, і спостерігач зіставить переказ без здогадок.

       У мережах із коментарем (TON) хвостик не потрібен: там ідентифікує
       memo, а сума лишається круглою. */
    const raw = amount / rate;
    let usdtAmount: number;
    let memo: string | undefined;

    if (net.memo) {
      usdtAmount = Math.round(raw * 10000) / 10000;
      // короткий код у коментар — його гравець вставляє при переказі
      memo = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    } else {
      const cents = Math.floor(raw * 100) / 100;
      const unit = this.freeMemoUnit(addr.id);
      usdtAmount = Math.round((cents + unit * MEMO_UNIT) * 10000) / 10000;
    }

    const now = Date.now();
    const rec: PaymentRecord = {
      id: randomUUID(),
      telegramId,
      method: 'crypto',
      network,
      token,
      amount: Math.round(amount),
      usdtAmount,
      memo,
      rate,
      rateApprox,
      address: addr.address,
      addressId: addr.id,
      status: 'pending',
      createdAt: now,
      expiresAt: now + PAYMENT_TTL_MS,
      /* Відсоток ЗАМОРОЖЕНО тут і більше не перечитується — див.
         коментар до Payment.promo в контрактах. */
      promo: promo?.code,
      promoPercent: promo?.percent,
    };
    this.items.set(rec.id, rec);
    this.persist(rec);
    this.log.log(`нова заявка ${rec.id}: ${telegramId} ${amount}₽ ` +
      `${promo ? `[промокод ${promo.code} +${promo.percent}%] ` : ''}` +
      `(${usdtAmount} ${token.toUpperCase()} у ${net.name}` +
      `${rateApprox ? ', курс ПРИБЛИЗНИЙ' : ''}) -> ${addr.address}` +
      `${memo ? ` memo ${memo}` : ''}`);
    return rec;
  }

  /* ---- рішення ---- */

  /* Порядок тут принциповий: СПЕРШУ гроші, і тільки якщо вони справді
     лягли — статус.

     Раніше заявка ставала approved до нарахування, а результат topUp()
     не перевірявся. Гравця немає в пам'яті (невідомий telegramId) ->
     topUp повертає null, гроші не зараховані, але заявка вже «погоджена»
     й повторно підтвердити її не можна: mustOpen() кине конфлікт.
     Тобто помилка адміна тихо з'їдала депозит. */
  approve(id: string, by: ResolvedBy = 'admin'): PaymentRecord {
    const rec = this.mustOpen(id);

    const balance = this.players.topUp(rec.telegramId, rec.amount, by === 'bot' ? 'бот' : 'адмін');
    if (balance === null) {
      throw new NotFoundException(
        `Игрок ${rec.telegramId} не найден — баланс не начислен, заявка осталась в ожидании`);
    }

    /* Депозит запрошеного друга веде до виплати тому, хто його привів
       (коли набереться поріг). Кличемо ПІСЛЯ того, як гроші реально
       лягли на баланс: до цього рядка нарахування ще могло не
       відбутись. Повторний виклик безпечний — усередині стоїть ознака
       вже оплаченої виплати. */
    this.referrals.onDeposit(rec.telegramId, rec.amount);

    /* Надбавка за промокодом — БОНУСНИМИ грошима, з відіграшем. Теж
       після того, як депозит реально ліг: нараховувати бонус за
       поповнення, якого не сталося, не можна.

       Заявка вже approved не стане двічі (mustOpen кидає на закритій),
       тож і нарахування тут рівно одне. */
    this.promos.grant(rec.telegramId, rec.amount, rec.promo, rec.promoPercent);

    rec.status = 'approved';
    rec.resolvedBy = by;
    rec.resolvedAt = Date.now();
    this.persist(rec);
    this.log.log(`заявку ${id} погоджено (${by}): ${rec.telegramId} +${rec.amount}₽ -> ${balance}`);
    return rec;
  }

  reject(id: string, note?: string, by: ResolvedBy = 'admin'): PaymentRecord {
    const rec = this.mustOpen(id);
    rec.status = 'rejected';
    rec.resolvedBy = by;
    rec.resolvedAt = Date.now();
    if (note) rec.adminNote = note.slice(0, 300);
    this.persist(rec);
    this.log.warn(`заявку ${id} скасовано (${by})${note ? `: ${note}` : ''}`);
    return rec;
  }

  /* Гравець знімає СВОЮ заявку сам.

     Дві перевірки, і обидві принципові:

     - заявка мусить належати тому, хто просить. Без цього будь-хто з
       валідним telegram-логіном закривав би чужі заявки за id;
     - тільки pending. У processing переказ уже знайдено в мережі:
       скасувати таку заявку означає викинути гроші, які вже пішли, —
       і саме тому тут ConflictException, а не мовчазний no-op. */
  cancelByPlayer(telegramId: number, id: string): PaymentRecord {
    this.sweep();
    const rec = this.items.get(id);
    if (!rec || rec.telegramId !== telegramId) {
      throw new NotFoundException('Заявка не найдена');
    }
    if (rec.status === 'processing') {
      throw new ConflictException(
        'Перевод уже найден в сети — заявку отменить нельзя, дождитесь зачисления');
    }
    if (rec.status !== 'pending') {
      throw new ConflictException(`Заявка уже в статусе «${rec.status}»`);
    }
    rec.status = 'canceled';
    rec.resolvedAt = Date.now();
    this.persist(rec);
    this.log.log(`заявку ${id} знято гравцем (${telegramId}, ${rec.amount}₽)`);
    return rec;
  }

  /* Заявка, яку ще можна закрити. Це і pending, і processing: у другому
     випадку бот уже знайшов переказ, але рішення все одно за адміном
     (напівавтомат) — і кнопка «Зарахувати» має працювати, а не казати
     «заявка вже в статусі processing». */
  private mustOpen(id: string): PaymentRecord {
    this.sweep();
    const rec = this.items.get(id);
    if (!rec) throw new NotFoundException('Заявка не найдена');
    if (rec.status !== 'pending' && rec.status !== 'processing') {
      throw new ConflictException(`Заявка уже в статусе «${rec.status}»`);
    }
    return rec;
  }
}
