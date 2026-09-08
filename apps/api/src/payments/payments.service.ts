import {
  BadRequestException, ConflictException, Inject, Injectable, Logger,
  NotFoundException, type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../config/env';
import { MongoService } from '../db/mongo.service';
import { RatesService } from '../rates/rates.service';
import { PlayersService } from '../players/players.service';
import { PaymentStore } from './payment-store';
import {
  PAYMENT_MAX_RUB, PAYMENT_MIN_RUB, PAYMENT_TTL_MS,
  type DepositAddress, type PaymentRecord,
} from './payment.types';
import {
  NETWORKS, TOKENS, isValidAddress, type Family, type NetworkId, type TokenId,
} from './networks';
import type { UnmatchedPayment, UnmatchedStatus } from './unmatched.types';
import { SettingsService } from '../settings/settings.service';

/* Скільки різних дробів можна дописати до суми. Пара «адреса + сума»
   має однозначно вказувати на заявку, бо в TRON, EVM і Solana немає
   коментаря до переказу. 0.0001..0.0099 — сто варіантів на адресу, і
   виглядає як звичайне округлення курсу, а не як код. */
const MEMO_STEPS = 99;
const MEMO_UNIT = 0.0001;

/* Наскільки сума переказу може розійтися з очікуваною, щоб її все одно
   визнали тією самою. Половина кроку дробу: більший допуск склеїв би
   дві сусідні заявки на одній адресі, і зіставлення стало б здогадкою. */
const AMOUNT_EPS = MEMO_UNIT / 2;

/** Прийшов переказ у мережі — рівно те, що бачить спостерігач. */
export interface IncomingTx {
  network: NetworkId;
  token: TokenId;
  /** наша адреса-отримувач */
  to: string;
  from: string;
  /** сума в токені, вже поділена на decimals */
  amount: number;
  txid: string;
  /** час переказу в мережі, мс */
  at: number;
  memo?: string;
}

/* Одна адреса + усе, що спостерігачу треба знати, щоб її слухати.
   Формується на льоту з поточних адрес і поточних налаштувань, тому
   окремої копії списку ніде немає й розсинхрону теж. */
export interface WatchTarget {
  addressId: string;
  address: string;
  family: Family;
  label?: string;
  /** раніше цього моменту перекази не наші — це історія гаманця */
  watchFrom: number;
  cursor?: string;
  scannedAt?: number;
  /** мережі цієї родини, увімкнені просто зараз */
  networks: NetworkId[];
  /** монети, які приймаємо просто зараз */
  tokens: TokenId[];
}

export type IngestResult =
  | { kind: 'duplicate'; txid: string }
  | { kind: 'matched'; payment: PaymentRecord; credited: boolean }
  | { kind: 'unmatched'; row: UnmatchedPayment; reason: string };

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PaymentsService.name);
  private readonly items = new Map<string, PaymentRecord>();
  private readonly addrs = new Map<string, DepositAddress>();
  private readonly unmatched = new Map<string, UnmatchedPayment>();
  private store: PaymentStore | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly mongo: MongoService,
    private readonly rates: RatesService,
    private readonly players: PlayersService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const db = await this.mongo.ready();
    if (db) {
      const store = new PaymentStore(db);
      for (const p of await store.loadAll()) this.items.set(p.id, p);
      for (const a of await store.loadAddresses()) this.addrs.set(a.id, a);
      for (const u of await store.loadUnmatched()) this.unmatched.set(u.id, u);
      this.store = store;
      this.log.log(`Завантажено: заявок ${this.items.size}, адрес ${this.addrs.size}, ` +
        `неопізнаних ${this.unmatched.size}`);
    }

    // сід із env: якщо адрес нема, а в конфізі задана валідна — заводимо
    const seed = this.env.usdtTrc20Address;
    if (seed && isValidAddress('tron', seed) && !this.addrList().some((a) => a.address === seed)) {
      this.addAddress('tron', seed, 'из .env');
    }

    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweep();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private persist(rec: PaymentRecord): void {
    this.store?.save(rec).catch((e) =>
      this.log.error(`не зберіглась заявка ${rec.id}: ${(e as Error).message}`));
  }
  private persistUnmatched(u: UnmatchedPayment): void {
    this.store?.saveUnmatched(u).catch((e) =>
      this.log.error(`не зберігся неопізнаний платіж ${u.id}: ${(e as Error).message}`));
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

  addAddress(family: Family, address: string, label?: string): DepositAddress {
    const addr = address.trim();
    if (!isValidAddress(family, addr)) {
      throw new BadRequestException('Адрес не подходит под формат этой сети');
    }
    if (this.addrList().some((a) => a.address === addr && a.family === family)) {
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

  /* Прогрес спостерігача по адресі. Лежить біля самої адреси, а не в
     пам'яті спостерігача: після рестарту він має продовжити з того ж
     місця, а не перечитувати все заново. */
  noteScan(id: string, cursor?: string): void {
    const a = this.addrs.get(id);
    if (!a) return;
    a.scannedAt = Date.now();
    if (cursor !== undefined) a.cursor = cursor;
    this.persistAddr(a);
  }

  /* Що слухати ПРОСТО ЗАРАЗ.

     Спостерігач викликає це кожен цикл, а не читає список один раз на
     старті. Тому адреса, додана хвилину тому, вже в роботі; вимкнена —
     вже ні; вимкнули мережу в CRM — перестали її дивитись. Жодного
     рестарту, жодної копії списку на боці спостерігача.

     Режим off повертає порожньо: це і є «бот не слухає взагалі». */
  watchTargets(): WatchTarget[] {
    const cfg = this.settings.getDeposits();
    if (cfg.mode === 'off') return [];

    const tokens = cfg.tokens.filter((t) => !!TOKENS[t]);
    if (!tokens.length) return [];

    return this.addrList()
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

  /** Вибрати адресу під заявку: потрібної РОДИНИ, активну, по
      можливості без жодної pending-заявки; інакше з найменшою
      кількістю. Родина, а не мережа: 0x-адреса обслуговує всі шість
      EVM-мереж, тож ділити її по мережах нема сенсу. */
  private pickAddress(family: Family): DepositAddress {
    const active = this.addrList().filter((a) => a.active && a.family === family);
    if (!active.length) {
      throw new BadRequestException('Эта сеть временно недоступна — нет адреса приёма');
    }
    const busy = this.pendingByAddr();
    return active.sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))[0];
  }

  /* Дріб, якого зараз немає в жодної активної заявки на цю адресу.
     Саме він робить пару «адреса + сума» унікальною. Якщо всі сто
     варіантів зайняті (це означало б сотню одночасних заявок на одну
     адресу), беремо випадковий: гірше зіставлення краще, ніж відмова
     створити заявку. */
  private freeMemoUnit(addressId: string, base: number): number {
    const taken = new Set<number>();
    for (const p of this.items.values()) {
      if (p.status === 'pending' && p.addressId === addressId) {
        taken.add(Math.round((p.usdtAmount - Math.floor(p.usdtAmount * 100) / 100) / MEMO_UNIT));
      }
    }
    for (let i = 1; i <= MEMO_STEPS; i++) if (!taken.has(i)) return i;
    void base;
    return 1 + Math.floor(Math.random() * MEMO_STEPS);
  }

  /* ---- заявки ---- */

  activeFor(telegramId: number): PaymentRecord | undefined {
    this.sweep();
    return [...this.items.values()].find(
      (p) => p.telegramId === telegramId && p.status === 'pending');
  }

  create(telegramId: number, amount: number, network: NetworkId, token: TokenId): PaymentRecord {
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

    const addr = this.pickAddress(net.family);
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
      const unit = this.freeMemoUnit(addr.id, cents);
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
    };
    this.items.set(rec.id, rec);
    this.persist(rec);
    this.log.log(`нова заявка ${rec.id}: ${telegramId} ${amount}₽ ` +
      `(${usdtAmount} ${token.toUpperCase()} у ${net.name}` +
      `${rateApprox ? ', курс ПРИБЛИЗНИЙ' : ''}) -> ${addr.address}` +
      `${memo ? ` memo ${memo}` : ''}`);
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

  /* Порядок тут принциповий: СПЕРШУ гроші, і тільки якщо вони справді
     лягли — статус.

     Раніше заявка ставала approved до нарахування, а результат topUp()
     не перевірявся. Гравця немає в пам'яті (невідомий telegramId) ->
     topUp повертає null, гроші не зараховані, але заявка вже «погоджена»
     й повторно підтвердити її не можна: mustPending() кине конфлікт.
     Тобто помилка адміна тихо з'їдала депозит. */
  approve(id: string): PaymentRecord {
    const rec = this.mustPending(id);

    const balance = this.players.topUp(rec.telegramId, rec.amount);
    if (balance === null) {
      throw new NotFoundException(
        `Игрок ${rec.telegramId} не найден — баланс не начислен, заявка осталась в ожидании`);
    }

    rec.status = 'approved';
    rec.resolvedAt = Date.now();
    this.persist(rec);
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

  /* ============================================================
     ЗІСТАВЛЕННЯ ПЕРЕКАЗІВ.

     Сюди приходить кожен переказ, який спостерігач побачив на наших
     адресах. Спостерігачів ще немає (потрібні ключі API), але вся
     логіка рішення живе тут, а не в них: у них лишиться саме читання
     мережі. Так її можна перевірити без жодного ключа, і чотири
     спостерігачі не розійдуться в поведінці.
     ============================================================ */

  /** txid, які вже зараховані або вже лежать серед неопізнаних. */
  private knownTxid(txid: string): boolean {
    const t = txid.toLowerCase();
    for (const p of this.items.values()) if (p.txid?.toLowerCase() === t) return true;
    for (const u of this.unmatched.values()) if (u.txid.toLowerCase() === t) return true;
    return false;
  }

  /* Адреси в EVM і TON пишуть у різних регістрах (0xAbC проти 0xabc),
     тож звіряти їх треба нечутливо до регістру. TRON і Solana такого не
     мають, але зайвим це не буде. */
  private static sameAddress(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  /* Заявка-кандидат під переказ.

     Мережа НЕ звіряється — звіряється родина. Гравець міг обрати
     Polygon, а відправити в Base: адреса та сама, наш спостерігач бачить
     обидві мережі, і карати за це втратою грошей нема за що. Токен
     звіряємо: USDT і USDC — різні гроші.

     У мережах із memo (TON) ідентифікує ТІЛЬКИ коментар. Відкату на суму
     там немає, і це принципово: сума в таких заявках кругла, бо
     хвостика їй не дописують, тож два гравці на однакову суму в ₽
     отримають однакове число USDT. Зіставлення за сумою в такій мережі
     зарахувало б переказ першій-ліпшій із них — тобто не тій людині.
     Немає memo або він чужий — переказ іде в неопізнані, і адмін
     розбереться сам. */
  private findCandidate(tx: IncomingTx): PaymentRecord | undefined {
    const family = NETWORKS[tx.network]?.family;
    if (!family) return undefined;

    const open = [...this.items.values()].filter((p) =>
      p.status === 'pending' &&
      p.token === tx.token &&
      NETWORKS[p.network]?.family === family &&
      PaymentsService.sameAddress(p.address, tx.to));

    if (NETWORKS[tx.network].memo) {
      const memo = tx.memo?.trim().toUpperCase();
      return memo ? open.find((p) => p.memo?.toUpperCase() === memo) : undefined;
    }
    return open.find((p) => Math.abs(p.usdtAmount - tx.amount) < AMOUNT_EPS);
  }

  private addUnmatched(tx: IncomingTx, reason: string): UnmatchedPayment {
    const row: UnmatchedPayment = {
      id: randomUUID(),
      network: tx.network, token: tx.token,
      address: tx.to, from: tx.from, amount: tx.amount,
      txid: tx.txid, at: tx.at, memo: tx.memo,
      status: 'new', seenAt: Date.now(),
      adminNote: reason,
    };
    this.unmatched.set(row.id, row);
    this.persistUnmatched(row);
    this.log.warn(`неопізнаний переказ ${tx.amount} ${tx.token.toUpperCase()} ` +
      `у ${tx.network} на ${tx.to} (${reason}), txid ${tx.txid}`);
    return row;
  }

  /* Головна точка входу спостерігача. Рішення залежить від режиму:

       watch — тільки пише в лог, що зробив би. Заявку не чіпає;
       semi  — позначає заявку оплаченою, кнопку лишає адміну;
       auto  — зараховує сам.

     Незіставлене складається в «неопізнані» в будь-якому режимі: це
     реальні гроші, які вже прийшли, і мовчки їх губити не можна. Зате
     нарахування — рівно там, де адмін його дозволив. */
  ingest(tx: IncomingTx): IngestResult {
    const mode = this.settings.getDeposits().mode;
    if (this.knownTxid(tx.txid)) return { kind: 'duplicate', txid: tx.txid };

    const rec = this.findCandidate(tx);
    if (!rec) {
      const reason = !NETWORKS[tx.network]?.memo
        ? 'сумма не совпала ни с одной заявкой'
        : tx.memo
          ? 'нет заявки с таким комментарием'
          : 'перевод без комментария — опознать некому';
      return { kind: 'unmatched', row: this.addUnmatched(tx, reason), reason };
    }

    if (mode === 'watch') {
      this.log.log(`[watch] зарахував би заявку ${rec.id}: ${rec.telegramId} ` +
        `+${rec.amount}₽ за ${tx.amount} ${tx.token.toUpperCase()}, txid ${tx.txid}`);
      return { kind: 'matched', payment: rec, credited: false };
    }

    rec.txid = tx.txid;
    rec.paidAmount = tx.amount;
    rec.matchedAt = Date.now();

    if (mode !== 'auto') {
      this.persist(rec);
      this.log.log(`заявку ${rec.id} позначено оплаченою, чекає кнопки адміна`);
      return { kind: 'matched', payment: rec, credited: false };
    }

    /* approve() сам поставить статус і збереже; якщо гравця немає —
       кине, і заявка лишиться pending із проставленим txid. Тоді її
       видно адміну як оплачену, але не зараховану, і він розбереться. */
    try {
      this.approve(rec.id);
      return { kind: 'matched', payment: rec, credited: true };
    } catch (e) {
      this.persist(rec);
      this.log.error(`авто-зарахування заявки ${rec.id} впало: ${(e as Error).message}`);
      return { kind: 'matched', payment: rec, credited: false };
    }
  }

  /* ---- неопізнані: перегляд і ручне рішення ---- */

  unmatchedList(): UnmatchedPayment[] {
    const rank = (st: UnmatchedStatus) => (st === 'new' ? 0 : 1);
    return [...this.unmatched.values()].sort(
      (a, b) => rank(a.status) - rank(b.status) || b.at - a.at);
  }

  private mustNewUnmatched(id: string): UnmatchedPayment {
    const u = this.unmatched.get(id);
    if (!u) throw new NotFoundException('Платёж не найден');
    if (u.status !== 'new') throw new ConflictException(`Платёж уже в статусе «${u.status}»`);
    return u;
  }

  /* Ручне зарахування неопізнаного переказу вибраному гравцю.

     Якщо суму в ₽ не задали, рахуємо за ПОТОЧНИМ курсом: курсу на
     момент переказу ми не знаємо, заявки ж не було. Адмін бачить
     підрахунок і може задати суму сам. Порядок той самий, що в
     approve(): спершу гроші, потім статус. */
  creditUnmatched(id: string, telegramId: number, rub?: number): UnmatchedPayment {
    const u = this.mustNewUnmatched(id);
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
    this.persistUnmatched(u);
    this.log.log(`неопізнаний ${id} зараховано: ${telegramId} +${amount}₽ -> ${balance}`);
    return u;
  }

  ignoreUnmatched(id: string, note?: string): UnmatchedPayment {
    const u = this.mustNewUnmatched(id);
    u.status = 'ignored';
    u.resolvedAt = Date.now();
    if (note) u.adminNote = note.slice(0, 300);
    this.persistUnmatched(u);
    return u;
  }
}
