'use client';

/* ============================================================
   DEPOSIT — вікно поповнення балансу.

   Опцій поки одна: USDT TRC20. Гравець вводить суму в ₽, тисне
   «Создать заявку» — і БІЛЬШЕ НІЧОГО не тисне: йому видається
   адреса гаманця, точна сума USDT і таймер на 30 хв. Далі він
   переказує кошти ззовні, а адмін у CRM звіряє транзакцію й
   погоджує заявку (баланс зарахується) або скасовує.
   Якщо за 30 хв підтвердження немає — заявка стає «истёкшей».
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Api, ApiError, type Payment, type PaymentsInfo } from '../lib/api';
import { Modal } from './Modal';

const QUICK = [500, 1000, 5000];
const rub = (n: number) => Math.round(n).toLocaleString('ru-RU');

const STATUS_RU: Record<Payment['status'], string> = {
  pending: 'ожидает оплаты',
  approved: 'зачислено',
  rejected: 'отклонено',
  expired: 'истёк срок',
};

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface Props {
  onClose: () => void;
  /** заявку закрито (погоджено / скасовано / протухла) — перечитати баланс */
  onResolved?: () => void;
}

export function DepositModal({ onClose, onResolved }: Props) {
  const [info, setInfo] = useState<PaymentsInfo | null>(null);
  const [amount, setAmount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setInfo(await Api.payments());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // секундна стрілка для таймера
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const active = info?.active ?? null;
  const activeId = active?.id ?? null;

  /* Поллимо статус, поки висить активна заявка.

     Залежність саме від id, а не від об'єкта заявки: кожен полл
     повертає НОВИЙ об'єкт, тому з `active` у залежностях ефект
     перезапускався (і таймер знищувався й створювався) кожні 8 с. */
  useEffect(() => {
    if (!activeId) return;
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [activeId, load]);

  /* Заявка зникла з активних — отже адмін її вирішив (або вона
     протухла). Баланс міг змінитись, а гра про це не знає: сама
     вона ходить на сервер лише за раундом. */
  const prevActiveId = useRef<string | null>(null);
  useEffect(() => {
    if (prevActiveId.current && !activeId) onResolved?.();
    prevActiveId.current = activeId;
  }, [activeId, onResolved]);

  const submit = async () => {
    if (amount < (info?.minRub ?? 100)) return;
    setBusy(true); setErr(null);
    try {
      const p = await Api.createPayment(amount);
      setInfo((prev) => prev ? { ...prev, active: p, history: [p, ...prev.history] } : prev);
      setAmount(0);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать заявку');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard недоступен */ }
  };

  const left = active ? active.expiresAt - now : 0;

  return (
    <Modal title="ПОПОЛНЕНИЕ" onClose={onClose}>
      {err && <p className="err">{err}</p>}

      {!active && (
        <section>
          <div className="dep-method">
            <span className="dep-method-badge">USDT · TRC20</span>
            <span className="dep-method-note">пока единственный способ</span>
          </div>

          <label className="dep-label" htmlFor="dep-amount">Сумма зачисления, ₽</label>
          <input
            id="dep-amount"
            className="input mono"
            type="number"
            inputMode="numeric"
            min={info?.minRub ?? 100}
            value={amount || ''}
            onChange={(e) => setAmount(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            placeholder={`от ${rub(info?.minRub ?? 100)}`}
          />
          <div className="dep-chips">
            {QUICK.map((q) => (
              <button key={q} type="button" className="dep-chip" onClick={() => setAmount((a) => a + q)}>
                +{rub(q)}
              </button>
            ))}
          </div>

          <p className="dep-est">Точную сумму USDT к переводу увидишь после создания заявки.</p>

          <button
            type="button"
            className="btn wide"
            disabled={busy || amount < (info?.minRub ?? 100)}
            onClick={() => void submit()}
          >
            {busy ? 'Создаю…' : 'СОЗДАТЬ ЗАЯВКУ'}
          </button>
        </section>
      )}

      {active && (
        <section className="dep-active">
          {left > 0 ? (
            <>
              <p className="dep-hint">
                Переведи ровно эту сумму USDT (TRC20) на адрес ниже.
                Больше ничего нажимать не нужно — как только средства придут
                и админ подтвердит, баланс пополнится.
              </p>

              <div className="dep-row">
                <span className="dep-k">Сумма</span>
                <span className="dep-v big">{active.usdtAmount} <small>USDT</small></span>
              </div>
              <div className="dep-row">
                <span className="dep-k">К зачислению</span>
                <span className="dep-v">{rub(active.amount)} ₽</span>
              </div>

              {/* Курс не приехал с биржи — сумма посчитана по запасному
                  значению. Молчать об этом нельзя: человек переводит
                  реальные деньги по этой цифре. */}
              {active.rateApprox && (
                <p className="dep-warn">
                  ⚠ Курс не удалось обновить, сумма посчитана по запасному
                  ({rub(active.rate)} ₽ за USDT) и может отличаться от рыночной.
                  Перед переводом лучше уточнить у поддержки.
                </p>
              )}

              <span className="dep-label">Адрес (TRC20)</span>
              <div className="dep-addr">
                <code>{active.address}</code>
                <button type="button" className="btn" onClick={() => void copy(active.address)}>
                  {copied ? '✓' : 'Копировать'}
                </button>
              </div>

              <div className={'dep-timer' + (left < 5 * 60_000 ? ' urgent' : '')}>
                осталось {mmss(left)}
              </div>
            </>
          ) : (
            <div className="dep-expired">
              <p>Срок заявки истёк.</p>
              <p className="dep-hint">Если ты уже перевёл средства — напиши в поддержку.
                Иначе создай новую заявку.</p>
              <button type="button" className="btn wide" onClick={() => void load()}>ОБНОВИТЬ</button>
            </div>
          )}
        </section>
      )}

      {info && info.history.length > 0 && (
        <section>
          <h3>Последние</h3>
          <div className="dep-hist">
            {info.history.slice(0, 3).map((p) => (
              <div key={p.id} className={'dep-hist-row st-' + p.status}>
                <span className="dep-hist-amt">{rub(p.amount)} ₽</span>
                <span className="dep-hist-st">{STATUS_RU[p.status]}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </Modal>
  );
}
