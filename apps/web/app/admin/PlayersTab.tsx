'use client';

import { useCallback, useEffect, useState } from 'react';
import s from './admin.module.css';
import { api, rub, when } from './lib';
import { useAsk } from '../../src/ui/Ask';
import { NumField } from '../../src/ui/NumField';

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
  /* ID игроков, чья опасная кнопка сейчас в полёте. Множество, а не
     флаг: обнуление одного не должно блокировать строку другого. */
  const [rowBusy, setRowBusy] = useState<ReadonlySet<number>>(() => new Set());
  const ask = useAsk();

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

  /* ---- необратимое ----

     Обе кнопки временные: их просили, чтобы разгребать последствия
     тестов и злоупотреблений вручную. Поэтому обе спрашивают
     подтверждение своим текстом (не «уверены?», а что именно
     произойдёт) и обе пишут в лог сервера, кто их нажал. */

  const withRow = async (id: number, fn: () => Promise<void>) => {
    if (rowBusy.has(id)) return;
    setRowBusy((prev) => new Set(prev).add(id));
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRowBusy((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const zeroBalance = (p: Player) => void withRow(p.telegramId, async () => {
    const who = p.firstName || 'ID ' + p.telegramId;
    if (!(await ask.confirm(
      `Обнулить баланс: ${who}? Сейчас там ${rub(p.balance)} ₽ — вернуть их можно ` +
      'только пополнением вручную.', true))) return;
    const body = await api<{ telegramId: number; balance: number }>(
      `/players/${p.telegramId}/zero`, { method: 'POST', body: '{}' });
    setPlayers((prev) => prev?.map((x) =>
      x.telegramId === body.telegramId ? { ...x, balance: body.balance } : x) ?? prev);
  });

  const removePlayer = (p: Player) => void withRow(p.telegramId, async () => {
    const who = p.firstName || 'ID ' + p.telegramId;
    if (!(await ask.confirm(
      `Удалить игрока ${who} насовсем? Пропадут баланс (${rub(p.balance)} ₽), сид и ` +
      'история раундов. Заявки на депозит и вывод останутся. Зайдёт снова — ' +
      'заведётся с нуля.', true))) return;
    await api(`/players/${p.telegramId}/delete`, { method: 'POST', body: '{}' });
    setPlayers((prev) => prev?.filter((x) => x.telegramId !== p.telegramId) ?? prev);
  });

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
                <td className={s.player} data-label="Игрок">
                  <div className="name">{p.firstName || 'Без имени'}</div>
                  <div className="sub">{p.username ? '@' + p.username : 'ID ' + p.telegramId}</div>
                </td>
                <td className={s.num} data-label="Баланс ₽"><span className={s.balance}>{rub(p.balance)}</span></td>
                <td className={s.num} data-label="Nonce">{p.nonce}</td>
                <td className={s.num} data-label="Серия">{p.dryStreak}</td>
                <td data-label="Был">{when(p.seenAt)}</td>
                <td className={s.num} data-label="">
                  <div className={s.rowActions}>
                    <button type="button" className={s.addBtn} aria-label="Пополнить"
                      onClick={() => { setTarget(p); setAmount(0); setErr(null); }}>+</button>
                    <button type="button" className={s.btnSm} disabled={rowBusy.has(p.telegramId)}
                      onClick={() => zeroBalance(p)}>Обнулить</button>
                    <button type="button" className={`${s.btnSm} ${s.no}`}
                      disabled={rowBusy.has(p.telegramId)}
                      onClick={() => removePlayer(p)}>Удалить</button>
                  </div>
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
            <NumField id="topup-amount" className={s.input}
              value={amount} onChange={setAmount} autoFocus />
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
      {ask.dialog}
    </>
  );
}
