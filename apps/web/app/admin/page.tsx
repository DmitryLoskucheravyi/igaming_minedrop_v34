'use client';

/* ============================================================
   АДМІН-ПАНЕЛЬ — /admin

   Тимчасова, на час тестів. Без авторизації; API-роут працює
   тільки поза продакшном. Список гравців + ручне поповнення
   балансу. Піднімається разом із рештою (це просто маршрут Next).
   ============================================================ */

import { useCallback, useEffect, useState } from 'react';
import s from './admin.module.css';

interface Player {
  telegramId: number;
  firstName: string;
  username: string | null;
  balance: number;
  nonce: number;
  dryStreak: number;
  createdAt: number;
  seenAt: number;
}

const QUICK = [250, 500, 1000];
const fmt = (n: number) => n.toLocaleString('ru-RU');
const when = (ms: number) =>
  new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function AdminPage() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [target, setTarget] = useState<Player | null>(null);
  const [amount, setAmount] = useState(0);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch('/api/admin/players', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { players: Player[] };
      setPlayers(body.players);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openTopUp = (p: Player) => { setTarget(p); setAmount(0); setErr(null); };
  const closeTopUp = () => { setTarget(null); setAmount(0); };

  const submit = async () => {
    if (!target || amount < 1) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/players/${target.telegramId}/topup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { telegramId: number; balance: number };
      setPlayers((prev) =>
        prev?.map((p) => (p.telegramId === body.telegramId ? { ...p, balance: body.balance } : p)) ?? prev);
      closeTopUp();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={s.shell}>
      <div className={s.head}>
        <h1>Игроки</h1>
        {players && <span className={s.count}>{players.length}</span>}
        <button type="button" className={s.refresh} onClick={() => void load()} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </button>
      </div>

      {err && !target && <div className={s.err}>{err}</div>}

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Игрок</th>
              <th className={s.num}>Баланс&nbsp;₽</th>
              <th className={s.num}>Nonce</th>
              <th className={s.num}>Стрик</th>
              <th>Был</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {players?.map((p) => (
              <tr key={p.telegramId}>
                <td className={s.player}>
                  <div className="name">{p.firstName || 'Без имени'}</div>
                  <div className="sub">{p.username ? '@' + p.username : 'ID ' + p.telegramId}</div>
                </td>
                <td className={s.num}><span className={s.balance}>{fmt(p.balance)}</span></td>
                <td className={s.num}>{p.nonce}</td>
                <td className={s.num}>{p.dryStreak}</td>
                <td>{when(p.seenAt)}</td>
                <td className={s.num}>
                  <button
                    type="button"
                    className={s.addBtn}
                    aria-label={'Пополнить ' + (p.firstName || p.telegramId)}
                    onClick={() => openTopUp(p)}
                  >
                    +
                  </button>
                </td>
              </tr>
            ))}
            {players && players.length === 0 && (
              <tr><td colSpan={6}><div className={s.empty}>Ни одного игрока ещё нет</div></td></tr>
            )}
            {!players && !err && (
              <tr><td colSpan={6}><div className={s.empty}>Загрузка…</div></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {target && (
        <div
          className={s.overlay}
          onClick={(e) => { if (e.target === e.currentTarget) closeTopUp(); }}
        >
          <div className={s.modal}>
            <h2>Пополнить: {target.firstName || ('ID ' + target.telegramId)}</h2>
            <p className={s.cur}>
              {target.username ? '@' + target.username + ' · ' : ''}
              текущий баланс <b>{fmt(target.balance)} ₽</b>
            </p>

            <label className={s.label} htmlFor="topup-amount">Сумма пополнения, ₽</label>
            <input
              id="topup-amount"
              className={s.input}
              type="number"
              inputMode="numeric"
              min={1}
              value={amount || ''}
              onChange={(e) => setAmount(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              autoFocus
            />

            <div className={s.chips}>
              {QUICK.map((q) => (
                <button key={q} type="button" className={s.chip} onClick={() => setAmount((a) => a + q)}>
                  +{fmt(q)}
                </button>
              ))}
            </div>

            {err && <div className={s.err}>{err}</div>}

            <div className={s.actions}>
              <button
                type="button"
                className={s.confirm}
                disabled={amount < 1 || saving}
                onClick={() => void submit()}
              >
                {saving ? 'Пополняю…' : `Пополнить на ${fmt(amount)} ₽`}
              </button>
              <button type="button" className={s.cancel} onClick={closeTopUp} disabled={saving}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
