'use client';

/* ============================================================
   НЕПОЗНАННЫЕ ПЕРЕВОДЫ — деньги, которые уже пришли, но ничьи.

   Заявка живёт 30 минут, перевод в блокчейне — вечно. Поэтому бот
   слушает адреса независимо от заявок, и всё, что не сошлось (перевод
   после истечения срока, округлённая сумма, платёж вообще без заявки,
   второй перевод по одной заявке), падает сюда, а не исчезает.

   Разобрать можно двумя способами: зачислить выбранному игроку или
   оставить как есть. Оба решения окончательные — строка после них
   не возвращается в работу.
   ============================================================ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import s from './admin.module.css';
import { api, rub, when, UNMATCHED_RU, type AdminUnmatched } from './lib';
import { useAsk } from './Ask';

export function UnmatchedTab({ onFresh }: { onFresh?: (n: number) => void }) {
  const [rows, setRows] = useState<AdminUnmatched[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const ask = useAsk();

  const load = useCallback(async () => {
    try {
      const b = await api<{ unmatched: AdminUnmatched[]; fresh: number }>('/unmatched');
      setRows(b.unmatched);
      onFresh?.(b.fresh);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [onFresh]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  /* Зачисление — два вопроса подряд: кому и сколько. Сумму
     предзаполняем по текущему курсу, но менять её можно: курса на
     момент того перевода мы не знаем, заявки-то не было. */
  const credit = async (u: AdminUnmatched) => {
    const who = await ask.prompt(
      'Кому зачислить', `Telegram ID игрока. Пришло ${u.amount} ${u.token.toUpperCase()} в ${u.networkName}.`, '');
    if (who === null) return;
    const telegramId = Number(who.trim());
    if (!Number.isInteger(telegramId) || telegramId <= 0) {
      setErr('Telegram ID должен быть числом');
      return;
    }
    const sum = await ask.prompt(
      'Сколько зачислить, ₽', 'Пусто — посчитаем по текущему курсу', '');
    if (sum === null) return;
    const rubAmount = sum.trim() ? Number(sum.trim()) : undefined;
    if (rubAmount !== undefined && (!Number.isFinite(rubAmount) || rubAmount <= 0)) {
      setErr('Сумма должна быть числом больше нуля');
      return;
    }

    setBusyId(u.id); setErr(null);
    try {
      await api(`/unmatched/${u.id}/credit`, {
        method: 'POST',
        body: JSON.stringify({ telegramId, rub: rubAmount ? Math.round(rubAmount) : undefined }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  };

  const ignore = async (u: AdminUnmatched) => {
    if (!(await ask.confirm(
      `Оставить ${u.amount} ${u.token.toUpperCase()} без зачисления? Строка закроется навсегда.`, true))) return;
    setBusyId(u.id); setErr(null);
    try {
      await api(`/unmatched/${u.id}/ignore`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  };

  const fresh = useMemo(() => (rows ?? []).filter((u) => u.status === 'new').length, [rows]);

  return (
    <>
      <p className={s.dim} style={{ marginBottom: 10 }}>
        Переводы, которые пришли на наши адреса, но не сошлись ни с одной заявкой.
        Деньги уже у нас — строка ждёт решения.
        {fresh > 0 && <> Нерешённых: <b>{fresh}</b>.</>}
      </p>

      {err && <div className={s.err}>{err}</div>}

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Пришло</th>
              <th>Сеть</th>
              <th>Отправитель</th>
              <th>Транзакция</th>
              <th>Почему не сошлось</th>
              <th>Когда</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows?.map((u) => (
              <tr key={u.id}>
                <td className={s.num} data-label="Пришло">
                  {u.amount} <span className={s.dim}>{u.token.toUpperCase()}</span>
                </td>
                <td data-label="Сеть">
                  {u.networkName}
                  {u.memo && <div className={s.dim}>memo: {u.memo}</div>}
                </td>
                <td data-label="Отправитель">
                  <div className={`${s.mono} ${s.wrapAny}`} style={{ maxWidth: 180 }}>{u.from}</div>
                </td>
                <td data-label="Транзакция">
                  <div className={`${s.mono} ${s.wrapAny}`} style={{ maxWidth: 180 }}>{u.txid}</div>
                </td>
                <td data-label="Почему не сошлось">
                  <span className={`${s.badge} ${u.status === 'new' ? s.pending : s.expired}`}>
                    {UNMATCHED_RU[u.status]}
                  </span>
                  {u.adminNote && <div className={s.dim}>{u.adminNote}</div>}
                  {u.status === 'credited' && (
                    <div className={s.dim}>
                      {u.player ?? 'ID ' + u.creditedTo} · {rub(u.creditedRub ?? 0)} ₽
                    </div>
                  )}
                </td>
                <td data-label="Когда">{when(u.at)}</td>
                <td data-label="">
                  {u.status === 'new' ? (
                    <div className={s.rowActions}>
                      <button type="button" className={`${s.btnSm} ${s.ok}`}
                        disabled={busyId !== null}
                        onClick={() => void credit(u)}>Зачислить</button>
                      <button type="button" className={`${s.btnSm} ${s.no}`}
                        disabled={busyId !== null}
                        onClick={() => void ignore(u)}>Оставить</button>
                    </div>
                  ) : <span className={s.dim}>—</span>}
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr><td colSpan={7}><div className={s.empty}>
                Непознанных переводов нет — всё сошлось с заявками
              </div></td></tr>
            )}
            {!rows && !err && (
              <tr><td colSpan={7}><div className={s.empty}>Загрузка…</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
      {ask.dialog}
    </>
  );
}
