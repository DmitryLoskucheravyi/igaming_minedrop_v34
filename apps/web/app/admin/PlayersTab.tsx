'use client';

import { useCallback, useEffect, useState } from 'react';
import s from './admin.module.css';
import { api, rub, when } from './lib';

interface Player {
  telegramId: number;
  firstName: string;
  username: string | null;
  balance: number;
  nonce: number;
  dryStreak: number;
  seenAt: number;
}

const QUICK = [250, 500, 1000];

export function PlayersTab() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [target, setTarget] = useState<Player | null>(null);
  const [amount, setAmount] = useState(0);
  const [saving, setSaving] = useState(false);

  /* quiet — фонове оновлення: без «Загрузка…» на кнопці, щоб таблиця
     не блимала кожні 15 секунд. */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setErr(null);
    try {
      const body = await api<{ players: Player[] }>('/players');
      setPlayers(body.players);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { if (!quiet) setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /* Баланси міняються поза CRM (раунди гравців, підтверджені заявки),
     тому таблиця освіжається сама — як і вкладка «Заявки». Раніше
     оновити її можна було лише кнопкою, і цифри тихо застарівали.
     Поки відкрите вікно поповнення — не чіпаємо: під ним лежить
     той самий гравець, і підміна рядка збила б поточний баланс. */
  useEffect(() => {
    if (target) return;
    const t = setInterval(() => void load(true), 15_000);
    return () => clearInterval(t);
  }, [load, target]);

  const submit = async () => {
    if (!target || amount < 1) return;
    setSaving(true); setErr(null);
    try {
      const body = await api<{ telegramId: number; balance: number }>(
        `/players/${target.telegramId}/topup`, { method: 'POST', body: JSON.stringify({ amount }) });
      setPlayers((prev) => prev?.map((p) =>
        p.telegramId === body.telegramId ? { ...p, balance: body.balance } : p) ?? prev);
      setTarget(null); setAmount(0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  };

  return (
    <>
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
              <th className={s.num}>Серия</th>
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
                <td className={s.num}><span className={s.balance}>{rub(p.balance)}</span></td>
                <td className={s.num}>{p.nonce}</td>
                <td className={s.num}>{p.dryStreak}</td>
                <td>{when(p.seenAt)}</td>
                <td className={s.num}>
                  <button type="button" className={s.addBtn} aria-label="Пополнить"
                    onClick={() => { setTarget(p); setAmount(0); setErr(null); }}>+</button>
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
        <div className={s.overlay} onClick={(e) => { if (e.target === e.currentTarget) setTarget(null); }}>
          <div className={s.modal}>
            <h2>Пополнить: {target.firstName || ('ID ' + target.telegramId)}</h2>
            <p className={s.cur}>
              {target.username ? '@' + target.username + ' · ' : ''}
              текущий баланс <b>{rub(target.balance)} ₽</b>
            </p>
            <label className={s.label} htmlFor="topup-amount">Сумма пополнения, ₽</label>
            <input id="topup-amount" className={s.input} type="number" inputMode="numeric" min={1}
              value={amount || ''}
              onChange={(e) => setAmount(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              autoFocus />
            <div className={s.chips}>
              {QUICK.map((q) => (
                <button key={q} type="button" className={s.chip} onClick={() => setAmount((a) => a + q)}>
                  +{rub(q)}
                </button>
              ))}
            </div>
            {err && <div className={s.err}>{err}</div>}
            <div className={s.actions}>
              <button type="button" className={s.confirm} disabled={amount < 1 || saving}
                onClick={() => void submit()}>
                {saving ? 'Пополняю…' : `Пополнить на ${rub(amount)} ₽`}
              </button>
              <button type="button" className={s.cancel} onClick={() => setTarget(null)} disabled={saving}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
