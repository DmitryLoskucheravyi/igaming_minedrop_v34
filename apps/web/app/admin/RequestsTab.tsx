'use client';

import { useCallback, useEffect, useState } from 'react';
import s from './admin.module.css';
import { api, rub, when, STATUS_RU, type AdminPayment } from './lib';

function mmss(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function RequestsTab({ onPending }: { onPending?: (n: number) => void }) {
  const [rows, setRows] = useState<AdminPayment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const body = await api<{ payments: AdminPayment[]; pending: number }>('/payments');
      setRows(body.payments);
      onPending?.(body.pending);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [onPending]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const p = setInterval(() => void load(), 10_000);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(p); clearInterval(t); };
  }, [load]);

  const act = async (id: string, action: 'approve' | 'reject') => {
    if (action === 'reject' && !confirm('Отклонить заявку?')) return;
    setBusyId(id); setErr(null);
    try {
      await api(`/payments/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  };

  return (
    <>
      <div className={s.head}>
        <h1>Заявки</h1>
        {rows && <span className={s.count}>{rows.length}</span>}
        <button type="button" className={s.refresh} onClick={() => void load()}>Обновить</button>
      </div>

      {err && <div className={s.err}>{err}</div>}

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Игрок</th>
              <th className={s.num}>₽</th>
              <th className={s.num}>USDT</th>
              <th>Адрес</th>
              <th>Статус</th>
              <th>Создана</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.map((p) => (
              <tr key={p.id}>
                <td className={s.player} data-label="Игрок">
                  <div className="name">{p.player?.firstName || 'ID ' + p.telegramId}</div>
                  <div className="sub">
                    {p.player?.username ? '@' + p.player.username : 'ID ' + p.telegramId}
                  </div>
                </td>
                <td className={s.num} data-label="₽">{rub(p.amount)}</td>
                <td className={s.num} data-label="USDT">
                  {p.usdtAmount}
                  {/* Курс на момент створення заявки не приїхав з біржі —
                      сума порахована по запасному значенню. Це треба
                      звірити ДО підтвердження, а не після. */}
                  {p.rateApprox && (
                    <span className={s.approx} title={`Курс приблизный: ${rub(p.rate)} ₽ за USDT (биржа не ответила). Сверь сумму перед подтверждением.`}>
                      ≈
                    </span>
                  )}
                </td>
                <td data-label="Адрес">
                  <div className={`${s.mono} ${s.wrapAny}`} style={{ maxWidth: 220 }}>{p.address}</div>
                  {p.addressLabel && <div className={s.dim}>{p.addressLabel}</div>}
                </td>
                <td data-label="Статус">
                  <span className={`${s.badge} ${s[p.status]}`}>{STATUS_RU[p.status]}</span>
                  {p.status === 'pending' && (
                    <div className={`${s.timer} ${p.expiresAt - now < 5 * 60000 ? s.urgent : ''}`}>
                      {mmss(p.expiresAt - now)}
                    </div>
                  )}
                  {p.adminNote && <div className={s.dim}>{p.adminNote}</div>}
                </td>
                <td data-label="Создана">{when(p.createdAt)}</td>
                <td data-label="">
                  {p.status === 'pending' ? (
                    <div className={s.rowActions}>
                      <button type="button" className={`${s.btnSm} ${s.ok}`} disabled={busyId === p.id}
                        onClick={() => void act(p.id, 'approve')}>Подтвердить</button>
                      <button type="button" className={`${s.btnSm} ${s.no}`} disabled={busyId === p.id}
                        onClick={() => void act(p.id, 'reject')}>Отклонить</button>
                    </div>
                  ) : <span className={s.dim}>—</span>}
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr><td colSpan={7}><div className={s.empty}>Заявок ещё не было</div></td></tr>
            )}
            {!rows && !err && (
              <tr><td colSpan={7}><div className={s.empty}>Загрузка…</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
