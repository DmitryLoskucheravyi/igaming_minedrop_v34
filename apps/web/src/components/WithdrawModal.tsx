'use client';

/* ============================================================
   ВИВЕДЕННЯ КОШТІВ.

   Дзеркало депозиту, але з одним принциповим розворотом: гроші
   списуються з балансу В МОМЕНТ ЗАЯВКИ, а не коли адмін її погодить.
   Інакше можна замовити виплату й далі грати тими самими грошима.

   Через це вікно завжди повідомляє свіжий баланс назовні (onBalance):
   заявка, скасування — усе це змінює баланс просто зараз, і HUD не
   має показувати стару цифру.

   Строку давності немає: заявка чекає на людину. Поки вона в
   очікуванні, гравець може скасувати її сам і забрати гроші назад.
   ============================================================ */

import { useCallback, useEffect, useState } from 'react';
import { Api, ApiError, type Withdraw, type WithdrawInfo } from '../lib/api';
import { CURRENCY_META, fmtWhole, type CurrencyCode, type Rates } from '../lib/currency';
import { Modal } from './Modal';

const STATUS_RU: Record<Withdraw['status'], string> = {
  pending: 'на рассмотрении',
  approved: 'выплачено',
  rejected: 'отклонено',
  canceled: 'отменено',
};

const when = (ms: number) =>
  new Date(ms).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

interface Props {
  balance: number;
  currency: CurrencyCode;
  rates: Rates;
  onClose: () => void;
  /** баланс змінився (заявка створена або скасована) — перечитати стан */
  onBalance: () => void;
}

export function WithdrawModal({ balance, currency, rates, onClose, onBalance }: Props) {
  const [info, setInfo] = useState<WithdrawInfo | null>(null);
  const [amount, setAmount] = useState(0);
  const [address, setAddress] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await Api.withdrawals());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const min = info?.minRub ?? 500;
  const active = info?.active ?? null;
  const meta = CURRENCY_META[currency];

  const money = (rub: number) => (
    <span className="money">
      {fmtWhole(rub, currency, rates)}
      <img className={'cur-ico' + (meta.mono ? ' mono' : '')} src={meta.icon} alt="" />
    </span>
  );

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await Api.createWithdraw(amount, address.trim());
      setInfo((prev) => prev
        ? { ...prev, active: r.withdraw, history: [r.withdraw, ...prev.history] }
        : prev);
      setAmount(0);
      onBalance();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать заявку');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!active) return;
    setBusy(true); setErr(null);
    try {
      await Api.cancelWithdraw(active.id);
      await load();
      onBalance();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось отменить');
    } finally {
      setBusy(false);
    }
  };

  const tooSmall = amount < min;
  const tooBig = amount > balance;

  return (
    <Modal title="ВЫВОД СРЕДСТВ" onClose={onClose}>
      {err && <p className="err">{err}</p>}

      {!active && (
        <section>
          <div className="dep-method">
            <span className="dep-method-badge">USDT · TRC20</span>
            <span className="dep-method-note">пока единственный способ</span>
          </div>

          <p className="hint">
            Средства списываются с баланса <b>сразу</b> при создании заявки.
            Пока админ её не обработал, заявку можно отменить — деньги вернутся.
          </p>

          <label className="dep-label" htmlFor="wd-amount">Сумма вывода, ₽</label>
          <input
            id="wd-amount"
            className="input mono"
            type="number"
            inputMode="numeric"
            min={min}
            value={amount || ''}
            onChange={(e) => setAmount(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            placeholder={`от ${min}`}
          />
          <div className="dep-chips">
            <button type="button" className="dep-chip" onClick={() => setAmount(min)}>
              минимум
            </button>
            <button
              type="button"
              className="dep-chip"
              onClick={() => setAmount(Math.floor(balance))}
              disabled={balance < min}
            >
              всё ({fmtWhole(balance, currency, rates)})
            </button>
          </div>

          <label className="dep-label" htmlFor="wd-address">Твой адрес TRC20</label>
          <input
            id="wd-address"
            className="input mono"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="T..."
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="dep-est">
            Проверь адрес символ в символ: перевод в блокчейне отменить нельзя.
          </p>

          <div className="wd-row">
            <span className="dep-k">На балансе</span>
            <span className="dep-v">{money(balance)}</span>
          </div>

          <button
            type="button"
            className="btn wide"
            disabled={busy || tooSmall || tooBig || address.trim().length < 30}
            onClick={() => void submit()}
          >
            {busy ? 'Создаю…'
              : tooBig ? 'НА БАЛАНСЕ НЕДОСТАТОЧНО'
              : 'СОЗДАТЬ ЗАЯВКУ'}
          </button>
        </section>
      )}

      {active && (
        <section className="dep-active">
          <p className="dep-hint">
            Заявка создана, средства уже списаны с баланса. Админ проверит её
            и отправит USDT на указанный адрес. Пока заявка в ожидании — её
            можно отменить, деньги вернутся на баланс.
          </p>

          <div className="dep-row">
            <span className="dep-k">К выплате</span>
            <span className="dep-v big">{active.usdtAmount} <small>USDT</small></span>
          </div>
          <div className="dep-row">
            <span className="dep-k">Списано</span>
            <span className="dep-v">{money(active.amount)}</span>
          </div>

          {active.rateApprox && (
            <p className="dep-warn">
              ⚠ Курс не удалось обновить, сумма посчитана по запасному
              ({Math.round(active.rate)} ₽ за USDT). Админ сверит её перед выплатой.
            </p>
          )}

          <span className="dep-label">Адрес получателя</span>
          <div className="dep-addr">
            <code>{active.address}</code>
          </div>

          <button type="button" className="btn wide wd-cancel" disabled={busy} onClick={() => void cancel()}>
            {busy ? '…' : 'ОТМЕНИТЬ ЗАЯВКУ'}
          </button>
        </section>
      )}

      {info && info.history.length > 0 && (
        <section>
          <h3>Последние</h3>
          <div className="pay-list">
            {info.history.slice(0, 5).map((w) => (
              <div key={w.id} className={'pay-item st-' + w.status}>
                <div className="pay-item-top">
                  <span className="pay-amt">−{fmtWhole(w.amount, currency, rates)}</span>
                  <span className="pay-status">{STATUS_RU[w.status]}</span>
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
      )}
    </Modal>
  );
}
