'use client';

/* Історія платежів гравця — окреме вікно з бургер-меню.
   Уся історія заявок на депозит зі статусами. */

import { Api, type PaymentsInfo } from '../lib/api';
import { Modal } from './Modal';
import { useResource } from '../hooks/useResource';
import { PAYMENT_STATUS_RU, rub, whenFull } from '../lib/format';

export function PaymentsPanel({ onClose }: { onClose: () => void }) {
  /* Вікно тільки читає — жодного стану, крім самого запиту, тут немає:
     завантаження, помилка й гонка відповідей живуть у useResource. */
  const { data, error, loading } = useResource<PaymentsInfo>(() => Api.payments());
  const rows = data?.history ?? [];

  return (
    <Modal title="История платежей" onClose={onClose}>
      {error && <p className="err">{error}</p>}
      {loading && !error && <p className="hint">Загрузка…</p>}
      {!loading && !error && rows.length === 0 && <p className="hint">Платежей ещё не было.</p>}

      {rows.length > 0 && (
        <div className="pay-list">
          {rows.map((p) => (
            <div key={p.id} className={'pay-item st-' + p.status}>
              <div className="pay-item-top">
                <span className="pay-amt">+{rub(p.amount)} ₽</span>
                <span className="pay-status">{PAYMENT_STATUS_RU[p.status]}</span>
              </div>
              <div className="pay-item-sub">
                <span>{p.usdtAmount} USDT · TRC20</span>
                <span>{whenFull(p.createdAt)}</span>
              </div>
              {p.adminNote && <div className="pay-note">{p.adminNote}</div>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
