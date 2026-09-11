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
import { WITHDRAW_STATUS_RU, rub, when, whenFull } from '../lib/format';

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
/* Смужка відіграшу бонусу. Показує не «скільки лишилось», а шлях: де
   був, де зараз, скільки до кінця — так зрозуміліше, що прогрес іде
   від ставок, а не з'являється сам. */
function BonusBar({ done, need, until, maxBet }: {
  done: number; need: number; until: number; maxBet: number;
}) {
  const left = Math.max(0, need - done);
  /* Ділити нема на що, якщо цілі немає: без цієї перевірки на порожньому
     стані вийшов би NaN у ширині. */
  const pct = need > 0 ? Math.min(100, Math.max(0, (done / need) * 100)) : 0;
  return (
    <div className="bonus-bar-wrap">
      <div className="bonus-bar"><i style={{ width: pct.toFixed(1) + '%' }} /></div>
      <p className="dep-sub">
        Отыграно {rub(done)} из {rub(need)} ₽ — осталось <b>{rub(left)} ₽</b> ставок.
        Деньги не списываются: это оборот.
        {maxBet > 0 && ` Пока бонус в отыгрыше, ставка не больше ${rub(maxBet)} ₽.`}
        {until > 0 && ` Успеть до ${whenFull(until)} — иначе бонус сгорит.`}
      </p>
    </div>
  );
}

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
          onClick={() => wd.setAmount(Math.floor(wd.available))}
          disabled={wd.available < wd.min}
        >
          всё (<Money rub={wd.available} currency={currency} rates={rates} whole />)
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

      {/* РОЗКЛАД БАЛАНСУ. На головному екрані баланс один — так і має
          бути, гравець грає всім разом. А тут, де йдеться про вивід,
          різниця вже принципова, і ховати її не можна. */}
      <div className="wd-row">
        <span className="dep-k">На балансе</span>
        <span className="dep-v"><Money rub={balance} currency={currency} rates={rates} whole /></span>
      </div>
      {wd.bonus.locked > 0 && (
        <>
          <div className="wd-row">
            <span className="dep-k">Доступно к выводу</span>
            <span className="dep-v ok">
              <Money rub={wd.available} currency={currency} rates={rates} whole />
            </span>
          </div>
          <div className="wd-row">
            <span className="dep-k">Бонус в отыгрыше</span>
            <span className="dep-v locked">
              <Money rub={wd.bonus.locked} currency={currency} rates={rates} whole />
            </span>
          </div>
          <BonusBar
            done={wd.bonus.done}
            need={wd.bonus.need}
            until={wd.bonus.until}
            maxBet={wd.bonus.maxBet}
          />
        </>
      )}

      <button
        type="button"
        className="btn wide"
        disabled={!wd.canSubmit}
        onClick={() => void wd.create()}
      >
        {wd.busy ? 'Создаю…'
          : wd.tooBig ? 'Больше, чем доступно к выводу'
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
