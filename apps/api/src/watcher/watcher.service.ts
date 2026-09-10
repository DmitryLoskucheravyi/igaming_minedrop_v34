import {
  Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ENV, type Env } from '../config/env';
import { NETWORKS, type Family } from '../payments/networks';
import { DepositAddressPool } from '../payments/deposit-addresses.service';
import { PaymentRequests } from '../payments/payment-requests.service';
import { TransferMatcher, type IngestResult } from '../payments/transfer-matcher.service';
import type { IncomingTx, WatchTarget } from '../payments/payment.types';
import { SettingsService } from '../settings/settings.service';
import type { ChainReader } from './chain.types';
import { evmReader } from './chains/evm';
import { tronReader } from './chains/tron';
import { tonReader } from './chains/ton';
import { solanaReader } from './chains/solana';

/* ============================================================
   СПОСТЕРІГАЧ — бот, який слухає перекази й нараховує баланс.

   Уся його робота — два кроки в циклі:

     1. обійти адреси, які CRM віддає прямо зараз (watchTargets), і
        згодувати кожен знайдений переказ у PaymentsService.ingest();
     2. добити заявки, які вже відлежали свій finalitySec: перепитати
        мережу, чи переказ на місці, і закрити їх через settle().

   Рішень він не приймає ЖОДНИХ. Яка це заявка, чи зараховувати, чи
   складати в неопізнані — усе вирішує PaymentsService, і це вкрито
   тестами без єдиного ключа (test/deposits.test.ts). Тут лишається
   HTTP, розклад і акуратність із помилками.

   ГОЛОВНЕ ПРО ПОМИЛКИ: впала одна родина — решта працює далі. Провайдер
   ліг, ключ протух, мережа моргнула — це нормальний стан життя, а не
   привід зупинити прийом грошей. Помилку запам'ятовуємо, її видно в
   CRM, а наступний цикл усе одно піде.

   ВИМКНЕНИЙ СПОСТЕРІГАЧ НІЧОГО НЕ ЛАМАЄ. Перекази від цього нікуди не
   діваються: гравці так само створюють заявки, гроші так само
   приходять, просто зіставляє їх адмін руками — рівно як до появи
   бота. Тому вимикати його безпечно, і саме тому рубильник є.
   ============================================================ */

const READERS: Record<Family, ChainReader> = {
  evm: evmReader,
  tron: tronReader,
  ton: tonReader,
  solana: solanaReader,
};

/** Що сталося з родиною в останньому циклі — це й показує CRM. */
export interface FamilyHealth {
  family: Family;
  provider: string;
  /** ключ заданий у .env */
  hasKey: boolean;
  /** адрес цієї родини в роботі просто зараз */
  addresses: number;
  lastRunAt?: number;
  lastOkAt?: number;
  lastError?: string;
  /** скільки переказів побачено за життя процесу */
  seen: number;
}

export interface WatcherStatus {
  /** це не продакшн — доступна симуляція переказу */
  dev: boolean;
  /** рубильник у CRM */
  enabled: boolean;
  /** наскільки боту дозволено чіпати гроші */
  mode: string;
  /** цикл іде просто зараз */
  running: boolean;
  pollMs: number;
  lastCycleAt?: number;
  /** скільки заявок бот закрив сам за життя процесу */
  credited: number;
  families: FamilyHealth[];
}

@Injectable()
export class WatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WatcherService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastCycleAt: number | undefined;
  private credited = 0;
  private readonly health = new Map<Family, FamilyHealth>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    /* Три залежності замість одного PaymentsService — і кожну видно,
       за чим саме спостерігач до неї ходить: адреси слухати, заявку
       знайти для симуляції, переказ зіставити й добити. */
    private readonly addresses: DepositAddressPool,
    private readonly requests: PaymentRequests,
    private readonly matcher: TransferMatcher,
    private readonly settings: SettingsService,
  ) {
    for (const [family, reader] of Object.entries(READERS) as [Family, ChainReader][]) {
      this.health.set(family, {
        family,
        provider: reader.provider,
        hasKey: !!this.keyFor(family),
        addresses: 0,
        seen: 0,
      });
    }
  }

  onModuleInit(): void {
    const missing = (Object.keys(READERS) as Family[]).filter((f) => !this.keyFor(f));
    if (missing.length) {
      /* Не помилка: приймати в одній родині й не заводити ключів під
         решту — робоча конфігурація. Але мовчати не можна: мережу в CRM
         увімкнути можна, а слухати її нічим. */
      this.log.warn(`Без ключа (слухатись не будуть): ${missing.join(', ')}. ` +
        'Змінні: TONAPI_KEY, TRONGRID_KEY, HELIUS_KEY, ANKR_KEY');
    }
    this.timer = setInterval(() => void this.cycle(), this.env.watcherPollMs);
    void this.cycle();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private keyFor(family: Family): string | null {
    return this.env.chainKeys[family] ?? null;
  }

  status(): WatcherStatus {
    const cfg = this.settings.getDeposits();
    /* Адреси рахуємо тим самим методом, який читає й сам цикл, — щоб у
       CRM було видно не переказ наміру, а робочий список. */
    const targets = this.addresses.watchTargets();
    for (const h of this.health.values()) {
      h.hasKey = !!this.keyFor(h.family);
      h.addresses = targets.filter((t) => t.family === h.family).length;
    }
    return {
      dev: !this.env.isProd,
      enabled: cfg.enabled,
      mode: cfg.mode,
      running: this.running,
      pollMs: this.env.watcherPollMs,
      lastCycleAt: this.lastCycleAt,
      credited: this.credited,
      families: [...this.health.values()],
    };
  }

  /** Позачерговий обхід — кнопка «Проверить сейчас» у CRM. */
  async runNow(): Promise<WatcherStatus> {
    await this.cycle();
    return this.status();
  }

  /* ============================================================
     СИМУЛЯЦІЯ ПЕРЕКАЗУ — тільки поза продакшном.

     Перевірити ланцюжок «переказ -> зіставлення -> баланс» інакше можна
     лише реальними грошима в реальній мережі. Це і повільно, і платно,
     і на дрібній помилці доводиться слати ще раз.

     Читачі мереж тут ні до чого: вони вже перевірені на живих даних
     (npm run test:chains). Неперевіреним лишається саме те, що робить
     цей метод — як система поводиться, коли переказ уже знайдено.

     ЧОМУ ЦЕ БЕЗПЕЧНО: у продакшні метод кидає, і це не налаштування, а
     властивість збірки — env.isProd приходить із NODE_ENV. Плюс txid
     починається з «dev-», тож підроблений переказ видно в CRM з
     першого погляду й переплутати його зі справжнім неможливо. */
  simulate(paymentId: string, amount?: number): IngestResult {
    if (this.env.isProd) {
      throw new Error('Симуляция перевода в продакшне недоступна');
    }
    const rec = this.requests.listAll().find((p) => p.id === paymentId);
    if (!rec) throw new Error('Заявка не найдена');

    const tx: IncomingTx = {
      network: rec.network,
      token: rec.token,
      to: rec.address,
      /* Відправник вигаданий, і це видно. Реальної адреси тут узятись
         нема звідки, а підставляти щось правдоподібне — гірше: у CRM
         воно виглядало б як справжній гаманець гравця. */
      from: 'dev-simulated-sender',
      amount: amount ?? rec.usdtAmount,
      txid: 'dev-' + randomUUID(),
      at: Date.now(),
      memo: rec.memo,
    };

    this.log.warn(`[СИМУЛЯЦІЯ] переказ ${tx.amount} ${tx.token.toUpperCase()} ` +
      `у ${tx.network} на ${tx.to}${tx.memo ? ` memo ${tx.memo}` : ''}`);
    const res = this.matcher.ingest(tx);
    this.log.warn(`[СИМУЛЯЦІЯ] результат: ${res.kind}` +
      (res.kind === 'unmatched' ? ` — ${res.reason}` : ''));
    return res;
  }

  /* ---- цикл ---- */

  private async cycle(): Promise<void> {
    /* Попередній обхід ще не закінчився. Накладати другий не можна:
       обидва прочитали б однаковий курсор і подвоїли роботу. */
    if (this.running) return;
    this.running = true;
    try {
      const targets = this.addresses.watchTargets();
      if (targets.length) await this.scanAll(targets);
      /* Фіналізацію робимо ЗАВЖДИ, навіть коли слухати нічого.

         Мережу могли вимкнути вже після того, як бот знайшов переказ, а
         заявка в processing — це чужі гроші, які вже в нас. Кинути її
         недобитою через зміну налаштувань не можна. */
      await this.settleAll();
      this.lastCycleAt = Date.now();
    } catch (e) {
      this.log.error(`цикл спостерігача впав: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /* Родини йдуть паралельно, адреси всередині родини — послідовно.

     Паралельно між родинами, бо це різні провайдери, і чекати TRON
     через повільний TON безглуздо. Послідовно всередині — бо провайдер
     один, і десяток одночасних запитів упреться в його ліміт частоти. */
  private async scanAll(targets: WatchTarget[]): Promise<void> {
    const byFamily = new Map<Family, WatchTarget[]>();
    for (const t of targets) {
      const list = byFamily.get(t.family) ?? [];
      list.push(t);
      byFamily.set(t.family, list);
    }
    await Promise.all([...byFamily].map(([family, list]) => this.scanFamily(family, list)));
  }

  private async scanFamily(family: Family, targets: WatchTarget[]): Promise<void> {
    const key = this.keyFor(family);
    const h = this.health.get(family)!;
    h.lastRunAt = Date.now();

    if (!key) {
      h.lastError = 'ключа немає — родина не слухається';
      return;
    }

    const reader = READERS[family];
    for (const t of targets) {
      try {
        const { txs, cursor } = await reader.scan({
          key,
          address: t.address,
          networks: t.networks,
          tokens: t.tokens,
          since: t.watchFrom,
          cursor: t.cursor,
        });

        for (const tx of txs) {
          h.seen++;
          const res = this.matcher.ingest(tx);
          if (res.kind === 'matched' && res.credited) this.credited++;
        }

        /* Курсор рухаємо ПІСЛЯ обробки. Впали на середині — наступний
           цикл перечитає той самий відрізок; повтори відсіє knownTxid,
           а от пропущений відрізок не помітив би ніхто. */
        this.addresses.noteScan(t.addressId, cursor);
        h.lastOkAt = Date.now();
        h.lastError = undefined;
      } catch (e) {
        h.lastError = `${t.label ?? t.address.slice(0, 12)}: ${(e as Error).message}`;
        this.log.error(`[${family}] ${h.lastError}`);
      }
    }
  }

  /* Заявки, які відлежали свій finalitySec. Перепитуємо мережу й
     закриваємо; що робити з відповіддю — вирішує TransferMatcher. */
  private async settleAll(): Promise<void> {
    for (const rec of this.matcher.settleReady()) {
      const family = NETWORKS[rec.network]?.family;
      const key = family ? this.keyFor(family) : null;
      /* Підроблений переказ (simulate) у мережі перепитувати нічого:
         його там немає й не було. Без цієї гілки доля тестової заявки
         залежала б від того, чим саме провайдер відповість на вигаданий
         txid — 404 він вважає відкатом блока й ЗАБРАКУВАВ БИ заявку. */
      if (!family || !key || !rec.txid || rec.txid.startsWith('dev-')) {
        this.matcher.settle(rec.id, 'unknown');
        continue;
      }
      const verdict = await READERS[family].confirm(key, rec.network, rec.txid);
      const done = this.matcher.settle(rec.id, verdict);
      if (done?.status === 'approved' && done.resolvedBy === 'bot') this.credited++;
    }
  }
}
