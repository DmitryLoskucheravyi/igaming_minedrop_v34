'use client';

import { useCallback, useEffect, useState } from 'react';
import s from './admin.module.css';
import { api, when, type AdminAddress } from './lib';

export function AddressesTab() {
  const [rows, setRows] = useState<AdminAddress[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await api<{ addresses: AdminAddress[] }>('/addresses');
      setRows(body.addresses);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!address.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api('/addresses', { method: 'POST', body: JSON.stringify({ address: address.trim(), label: label.trim() || undefined }) });
      setAddress(''); setLabel('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const toggle = async (a: AdminAddress) => {
    setRows((prev) => prev?.map((x) => x.id === a.id ? { ...x, active: !x.active } : x) ?? prev);
    try {
      await api(`/addresses/${a.id}`, { method: 'POST', body: JSON.stringify({ active: !a.active }) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      await load();
    }
  };

  const rename = async (a: AdminAddress) => {
    const next = prompt('Заголовок адреса (для тебя, чтобы различать)', a.label ?? '');
    if (next === null) return;
    try {
      await api(`/addresses/${a.id}`, { method: 'POST', body: JSON.stringify({ label: next }) });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (a: AdminAddress) => {
    if (a.pending > 0 && !confirm(`На адресе ${a.pending} активн. заявок. Всё равно удалить?`)) return;
    if (a.pending === 0 && !confirm('Удалить адрес?')) return;
    try {
      await api(`/addresses/${a.id}/delete`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className={s.head}>
        <h1>Адреса приёма (USDT TRC20)</h1>
        {rows && <span className={s.count}>{rows.length}</span>}
        <button type="button" className={s.refresh} onClick={() => void load()}>Обновить</button>
      </div>

      <div className={s.addrForm}>
        <input className={s.input} placeholder="Адрес TRC20 (T…)" value={address}
          onChange={(e) => setAddress(e.target.value)} />
        <input className={`${s.input} ${s.short}`} placeholder="Заголовок (необяз.)" value={label}
          onChange={(e) => setLabel(e.target.value)} />
        <button type="button" className={s.confirm} onClick={() => void add()} disabled={busy || !address.trim()}>
          {busy ? '…' : 'Добавить'}
        </button>
      </div>

      {err && <div className={s.err}>{err}</div>}

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Адрес</th>
              <th>Заголовок</th>
              <th className={s.num}>Заявок</th>
              <th>Статус</th>
              <th>Добавлен</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.map((a) => (
              <tr key={a.id}>
                <td data-label="Адрес"><span className={`${s.mono} ${s.wrapAny}`}>{a.address}</span></td>
                <td data-label="Заголовок">{a.label || <span className={s.dim}>—</span>}</td>
                <td className={s.num} data-label="Заявок">{a.pending}</td>
                <td data-label="Статус"><span className={`${s.badge} ${a.active ? s.approved : s.expired}`}>
                  {a.active ? 'активен' : 'выключен'}
                </span></td>
                <td data-label="Добавлен">{when(a.createdAt)}</td>
                <td data-label="">
                  <div className={s.rowActions}>
                    <button type="button" className={s.btnSm} onClick={() => void toggle(a)}>
                      {a.active ? 'Выкл' : 'Вкл'}
                    </button>
                    <button type="button" className={s.btnSm} onClick={() => void rename(a)}>Заголовок</button>
                    <button type="button" className={`${s.btnSm} ${s.no}`} onClick={() => void remove(a)}>Удалить</button>
                  </div>
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr><td colSpan={6}><div className={s.empty}>Адресов ещё нет — добавь хотя бы одну</div></td></tr>
            )}
            {!rows && !err && (
              <tr><td colSpan={6}><div className={s.empty}>Загрузка…</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
