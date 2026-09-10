'use client';

/* ============================================================
   ВИВЕДЕННЯ КОШТІВ.

   Дзеркало депозиту, але гроші списуються В МОМЕНТ ЗАЯВКИ, а не коли
   адмін її погодить: інакше можна замовити виплату й далі грати тими
   самими грошима. Поки заявка в очікуванні, гравець може скасувати її
   сам і забрати гроші назад.

   Скасування питає підтвердження СВОЇМ діалогом (src/ui/Ask), не
   нативним confirm(): той малює браузер, і в частині вебв'ю його можна
   вимкнути назавжди галочкою «більше не показувати». Тоді заявка
   скасовувалась би з одного випадкового тапу.

   Правила (межі сум, формат адреси, що з балансом) живуть у
   hooks/useWithdraw — тут тільки розмітка.
   ============================================================ */

import type { Withdraw } from '../lib/api';
import { fmtWhole, type CurrencyCode, type Rates } from '../lib/currency';
import { Modal } from './Modal';
import { Money } from './Money';
import { NumField } from '../ui/NumField';
import { useAsk } from '../ui/Ask';
import { useWithdraw, type WithdrawState } from '../hooks/useWithdraw';
import { WITHDRAW_STATUS_RU, when } from '../lib/format';

interface Props {
  balance: number;
  currency: CurrencyCode;
  rates: Rates;
  onClose: () => void;
  /** баланс змінився (заявка створена або скасована) — перечитати стан */
  onBalance: () => void;
}

export function WithdrawModal({ balance, currency, rates, onClose, onBalance }: Props) {
  const wd = useWithdraw(balance, onBalance);
  const ask = useAsk();

  const cancel = async () => {
    if (await ask.confirm('Отменить заявку? Деньги вернутся на баланс.')) await wd.cancel();
  };

  return (
    <Modal title="Вывод средств" onClose={onClose}>
      {wd.error && <p className="err">{wd.error}</p>}

      {!wd.active && <WithdrawForm wd={wd} balance={balance} currency={currency} rates={rates} />}

      {wd.active && (
        <ActiveWithdraw
          active={wd.active}
          busy={wd.busy}
          currency={currency}
          rates={rates}
          onCancel={() => void cancel()}
        />
      )}

      {!!wd.info?.history.length && (
        <History rows={wd.info.history} currency={currency} rates={rates} />
      )}

      {/* власний confirm — рендериться поверх вікна */}
      {ask.dialog}
    </Modal>
  );
}

/* ---- форма заявки ---- */
function WithdrawForm({ wd, balance, currency, rates }: {
  wd: WithdrawState; balance: number; currency: CurrencyCode; rates: Rates;
}) {
  return (
    <section>
      <div className="dep-method">
        <span className="dep-method-badge">USDT · TRC20</span>
        <span className="dep-method-note">пока единственный способ</span>
      </div>

      <label className="dep-label" htmlFor="wd-amount">Сумма вывода, ₽</label>
      <NumField
        id="wd-amount"
        value={wd.amount}
        onChange={wd.setAmount}
        placeholder={`от ${wd.min}`}
      />
      <p className="dep-sub">Спишем с баланса сразу. Отменишь — вернём.</p>

      <div className="dep-chips">
        <button type="button" className="dep-chip" onClick={() => wd.setAmount(wd.min)}>
          минимум
        </button>
        <button
          type="button"
          className="dep-chip"
          onClick={() => wd.setAmount(Math.floor(balance))}
          disabled={balance < wd.min}
        >
          всё (<Money rub={balance} currency={currency} rates={rates} whole />)
        </button>
      </div>

      <label className="dep-label" htmlFor="wd-address">Твой адрес TRC20</label>
      <input
        id="wd-address"
        className="input mono"
        value={wd.address}
        onChange={(e) => wd.setAddress(e.target.value)}
        placeholder="T..."
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
      />
      <p className="dep-sub">
        {wd.badAddress
          ? 'Адрес TRC20 — это T и ещё 33 символа.'
          : 'Сверь адрес: перевод в блокчейне не отменить.'}
      </p>

      <div className="wd-row">
        <span className="dep-k">На балансе</span>
        <span className="dep-v"><Money rub={balance} currency={currency} rates={rates} whole /></span>
      </div>

      <button
        type="button"
        className="btn wide"
        disabled={!wd.canSubmit}
        onClick={() => void wd.create()}
      >
        {wd.busy ? 'Создаю…'
          : wd.tooBig ? 'На балансе недостаточно'
          : wd.overMax ? `Максимум ${wd.max} ₽`
          : 'Создать заявку'}
      </button>
    </section>
  );
}

/* ---- заявка, яка чекає адміна ---- */
function ActiveWithdraw({ active, busy, currency, rates, onCancel }: {
  active: Withdraw; busy: boolean; currency: CurrencyCode; rates: Rates; onCancel: () => void;
}) {
  return (
    <section>
      {/* Один рядок замість абзацу: гравцеві тут треба знати, що заявка
          жива й на якій вона стадії, а не як її обробляють. */}
      <p className="hint">Заявка на рассмотрении.</p>

      <div className="dep-row">
        <span className="dep-k">К выплате</span>
        <span className="dep-v big">{active.usdtAmount} <small>USDT</small></span>
      </div>
      <div className="dep-row">
        <span className="dep-k">Списано</span>
        <span className="dep-v"><Money rub={active.amount} currency={currency} rates={rates} whole /></span>
      </div>

      {active.rateApprox && (
        <p className="dep-warn">
          Курс запасной ({Math.round(active.rate)} ₽ за USDT) — админ сверит.
        </p>
      )}

      <span className="dep-label">Адрес получателя</span>
      <div className="dep-addr">
        <code>{active.address}</code>
      </div>

      <button type="button" className="btn wide danger" disabled={busy} onClick={onCancel}>
        {busy ? '…' : 'Отменить заявку'}
      </button>
    </section>
  );
}

/* ---- останні заявки ---- */
function History({ rows, currency, rates }: {
  rows: Withdraw[]; currency: CurrencyCode; rates: Rates;
}) {
  return (
    <section>
      <h3>Последние</h3>
      <div className="pay-list">
        {rows.slice(0, 5).map((w) => (
          <div key={w.id} className={'pay-item st-' + w.status}>
            <div className="pay-item-top">
              <span className="pay-amt">−{fmtWhole(w.amount, currency, rates)}</span>
              <span className="pay-status">{WITHDRAW_STATUS_RU[w.status]}</span>
            </div>
            <div className="pay-item-sub">
              <span>{w.usdtAmount} USDT · TRC20</span>
              <span>{when(w.createdAt)}</span>
            </div>
            {w.adminNote && <div className="pay-note">{w.adminNote}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
