import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { PaymentRequests } from './payment-requests.service';
import { UnmatchedRegistry } from './unmatched.service';
import { AMOUNT_EPS, type IncomingTx, type PaymentRecord } from './payment.types';
import type { UnmatchedPayment } from './unmatched.types';
import { NETWORKS } from './networks';

/* ============================================================
   ЗІСТАВЛЕННЯ ПЕРЕКАЗІВ — рішення про чужі гроші.

   Сюди приходить кожен переказ, який спостерігач побачив на наших
   адресах. Читачі мереж (watcher/chains) уміють лише читати; УСЕ, що
   вирішує долю переказу, живе тут — тому чотири спостерігачі не можуть
   розійтися в поведінці, а перевірити логіку можна без жодного ключа
   API (див. test/deposits.test.ts).

   Робота ділиться на дві половини, і між ними стоїть ЧАС:
     ingest()      ловить переказ і кладе заявку в processing;
     settleReady() + settle() добивають її, коли мережа підтвердить.

   Індексатор бачить переказ, щойно той потрапив у блок, а блок ще може
   відкотитись — тому грошей не чіпаємо НІ В ЯКОМУ режимі, доки заявка
   не відлежить finalitySec своєї мережі.
   ============================================================ */

/* Чи знайшлась заявка під переказ — і якщо ні, то чому саме.

   Причина потрібна не для краси: вона лягає в рядок неопізнаного
   платежу, і саме з неї адмін розуміє, що сталося, не лізучи в
   блокчейн. «Не зіставилось» без пояснення означало б ручне
   розслідування на кожен такий переказ. */
type Match =
  | { ok: true; rec: PaymentRecord }
  | { ok: false; reason: string };

export type IngestResult =
  | { kind: 'duplicate'; txid: string }
  | { kind: 'matched'; payment: PaymentRecord; credited: boolean }
  | { kind: 'unmatched'; row: UnmatchedPayment; reason: string };

/* Адреси в EVM і TON пишуть у різних регістрах (0xAbC проти 0xabc),
   тож звіряти їх треба нечутливо до регістру. TRON і Solana такого не
   мають, але зайвим це не буде. */
const sameAddress = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

@Injectable()
export class TransferMatcher {
  private readonly log = new Logger(TransferMatcher.name);

  constructor(
    private readonly requests: PaymentRequests,
    private readonly unmatched: UnmatchedRegistry,
    private readonly settings: SettingsService,
  ) {}

  /** txid, які вже зараховані або вже лежать серед неопізнаних. */
  private knownTxid(txid: string): boolean {
    return this.requests.hasTxid(txid) || this.unmatched.hasTxid(txid);
  }

  /* Заявка-кандидат під переказ.

     Мережа НЕ звіряється — звіряється родина. Гравець міг обрати
     Polygon, а відправити в Base: адреса та сама, наш спостерігач бачить
     обидві мережі, і карати за це втратою грошей нема за що. Токен
     звіряємо: USDT і USDC — різні гроші.

     У мережах із memo (TON) ЗНАЙТИ заявку можна тільки за коментарем, і
     це принципово: сума в таких заявках кругла, бо хвостика їй не
     дописують, тож два гравці на однакову суму в ₽ отримають однакове
     число USDT. Пошук за сумою в такій мережі зарахував би переказ
     першій-ліпшій із них — тобто не тій людині.

     Але ЗНАЙТИ і ЗАРАХУВАТИ — різні речі. Коментар лише каже, чия це
     заявка; чи вистачає грошей, він не каже нічого. Доки суму не
     звіряли, будь-хто міг створити заявку на п'ять мільйонів, надіслати
     0.01 USDT із її кодом — і отримати п'ять мільйонів на баланс.
     Тому нижче стоїть окрема перевірка на недоплату. */
  private findCandidate(tx: IncomingTx): Match {
    const family = NETWORKS[tx.network]?.family;
    if (!family) return { ok: false, reason: 'неизвестная сеть' };

    /* Саме pending, а не «жива»: у заявці в processing переказ уже є,
       і другий переказ на ту саму суму — це окремі гроші, які мають
       піти в неопізнані, а не тихо злитись із першим. */
    const open = this.requests.pendingList().filter((p) =>
      p.token === tx.token &&
      NETWORKS[p.network]?.family === family &&
      sameAddress(p.address, tx.to));

    if (!NETWORKS[tx.network].memo) {
      /* Тут сума І Є пошуком: унікальний дріб робить пару «адреса +
         сума» вказівником на одну заявку. Не збіглась — не наша. */
      const byAmount = open.find((p) => Math.abs(p.usdtAmount - tx.amount) < AMOUNT_EPS);
      return byAmount
        ? { ok: true, rec: byAmount }
        : { ok: false, reason: 'сумма не совпала ни с одной заявкой' };
    }

    const memo = tx.memo?.trim().toUpperCase();
    if (!memo) return { ok: false, reason: 'перевод без комментария — опознать некому' };

    const rec = open.find((p) => p.memo?.toUpperCase() === memo);
    if (!rec) return { ok: false, reason: 'нет заявки с таким комментарием' };

    /* НЕДОПЛАТА. Коментар правильний, але грошей менше, ніж просили.

       Не відхиляємо й не зараховуємо: це справжні гроші конкретної
       людини, яку ми навіть знаємо на ім'я. Кладемо адміну з точною
       різницею — хай вирішить, зарахувати частково чи попросити
       доплатити. Переплату, навпаки, пропускаємо: заявка закриється,
       а надлишок буде видно в paidAmount. */
    if (tx.amount < rec.usdtAmount - AMOUNT_EPS) {
      const short = Math.round((rec.usdtAmount - tx.amount) * 10000) / 10000;
      return {
        ok: false,
        reason: `недоплата по заявке ${rec.id.slice(0, 8)}: пришло ${tx.amount} ` +
          `из ${rec.usdtAmount} ${tx.token.toUpperCase()} (не хватает ${short})`,
      };
    }
    return { ok: true, rec };
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

    /* Підозрілий переказ не зіставляємо взагалі — навіть якщо сума
       випадково зійшлася з якоюсь заявкою. Сума й є те, чому тут не
       можна вірити. */
    if (tx.suspect) {
      return { kind: 'unmatched', row: this.unmatched.add(tx, tx.suspect), reason: tx.suspect };
    }

    const match = this.findCandidate(tx);
    if (!match.ok) {
      const { reason } = match;
      return { kind: 'unmatched', row: this.unmatched.add(tx, reason), reason };
    }
    const rec = match.rec;

    if (mode === 'watch') {
      this.log.log(`[watch] зарахував би заявку ${rec.id}: ${rec.telegramId} ` +
        `+${rec.amount}₽ за ${tx.amount} ${tx.token.toUpperCase()}, txid ${tx.txid}`);
      return { kind: 'matched', payment: rec, credited: false };
    }

    /* Одна й та сама пауза для авто й напівавтомата навмисно: у
       напівавтоматі адмін теж не має тиснути «Зарахувати» на переказі,
       який ще не встоявся. */
    const now = Date.now();
    rec.status = 'processing';
    rec.txid = tx.txid;
    rec.paidAmount = tx.amount;
    rec.matchedAt = now;
    rec.confirmAt = now + (NETWORKS[tx.network]?.finalitySec ?? 60) * 1000;
    this.requests.persist(rec);
    this.log.log(`заявка ${rec.id} -> в обробці ботом: ${tx.amount} ` +
      `${tx.token.toUpperCase()}, txid ${tx.txid}, чекаємо мережу ` +
      `${Math.round((rec.confirmAt - now) / 1000)} с`);
    return { kind: 'matched', payment: rec, credited: false };
  }

  /** Заявки, які відлежали своє й чекають перевірки в мережі. */
  settleReady(): PaymentRecord[] {
    const now = Date.now();
    return this.requests.processingList().filter(
      (p) => !!p.txid && !p.confirmedAt && (p.confirmAt ?? 0) <= now);
  }

  /* Рішення після перевірки переказу в мережі.

     'ok'      — переказ на місці: авто зараховує, напівавтомат лишає
                 заявку в processing із позначкою «підтверджено» і
                 чекає кнопки адміна;
     'gone'    — мережа ПРЯМО каже, що такого переказу немає (відкат
                 блока). Єдиний випадок, коли бот відхиляє сам;
     'unknown' — перепитати не вийшло (провайдер ліг, метод не
                 підтримується). Тоді віримо індексатору, який цей
                 переказ нам і показав, і рахуємо його підтвердженим:
                 підвісити чужі гроші через нашу проблему зі зв'язком
                 гірше, ніж зарахувати їх на секунду раніше. */
  settle(id: string, verdict: 'ok' | 'gone' | 'unknown'): PaymentRecord | undefined {
    const rec = this.requests.get(id);
    if (!rec || rec.status !== 'processing') return rec;

    if (verdict === 'gone') {
      this.log.error(`переказ заявки ${rec.id} зник із мережі (txid ${rec.txid}) — відхиляю`);
      return this.requests.reject(rec.id, 'перевод пропал из сети (откат блока)', 'bot');
    }

    rec.confirmedAt = Date.now();
    if (verdict === 'unknown') {
      this.log.warn(`переказ заявки ${rec.id} перепитати не вийшло — ` +
        'вірю індексатору й вважаю підтвердженим');
    }

    if (this.settings.getDeposits().mode !== 'auto') {
      this.requests.persist(rec);
      this.log.log(`заявка ${rec.id} підтверджена мережею, чекає кнопки адміна`);
      return rec;
    }

    /* approve() сам поставить статус і збереже; якщо гравця немає —
       кине, і заявка лишиться в processing із проставленим txid. Тоді
       її видно адміну як оплачену, але не зараховану, і він розбереться
       сам. Другого автоматичного заходу не буде: confirmedAt уже
       стоїть, і settleReady() її більше не поверне. */
    try {
      return this.requests.approve(rec.id, 'bot');
    } catch (e) {
      this.requests.persist(rec);
      this.log.error(`авто-зарахування заявки ${rec.id} впало: ${(e as Error).message}`);
      return rec;
    }
  }
}
