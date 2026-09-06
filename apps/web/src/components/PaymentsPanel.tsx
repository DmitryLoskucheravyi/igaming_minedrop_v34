'use client';

/* Історія платежів гравця — окреме вікно з бургер-меню.
   Уся історія заявок на депозит зі статусами. */

import { useEffect, useState } from 'react';
import { Api, type Payment } from '../lib/api';

const rub = (n: number) => Math.round(n).toLocaleString('ru-RU');
const STATUS_RU: Record<Payment['status'], string> = {
  pending: 'ожидает',
  approved: 'зачислено',
  rejected: 'отклонено',
  expired: 'истёк срок',
};
const when = (ms: number) =>
  new Date(ms).toLocaleString('ru-RU',
    { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

export function PaymentsPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Payment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Api.payments()
      .then((r) => setRows(r.history))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="modal" role="dialog" aria-label="История платежей">
      <div className="modalbox">
        <div className="modalhead">
          <h2>ИСТОРИЯ ПЛАТЕЖЕЙ</h2>
          <button type="button" className="x" onClick={onClose}>✕</button>
        </div>

        {err && <p className="err">{err}</p>}
        {!rows && !err && <p className="hint">Загрузка…</p>}
        {rows && rows.length === 0 && <p className="hint">Платежей ещё не было.</p>}

        {rows && rows.length > 0 && (
          <div className="pay-list">
            {rows.map((p) => (
              <div key={p.id} className={'pay-item st-' + p.status}>
                <div className="pay-item-top">
                  <span className="pay-amt">+{rub(p.amount)} ₽</span>
                  <span className="pay-status">{STATUS_RU[p.status]}</span>
                </div>
                <div className="pay-item-sub">
                  <span>{p.usdtAmount} USDT · TRC20</span>
                  <span>{when(p.createdAt)}</span>
                </div>
                {p.adminNote && <div className="pay-note">{p.adminNote}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
