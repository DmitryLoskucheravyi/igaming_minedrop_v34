'use client';

/* ============================================================
   ЗАЯВКИ — три підвкладки: депозити, виводи й непізнані перекази.

   Вони поруч, бо це один робочий процес («що чекає на мене»), але
   таблиці різні: у депозиті адреса НАША (куди гравець переказує), у
   виводі — ГРАВЦЯ (куди переказуємо ми). Плутати їх не можна, тому
   підпис колонки різний.

   Головна різниця в грошах: депозит зараховує баланс при погодженні,
   а вивід уже списав його при створенні заявки. Тому відхилення
   виводу ПОВЕРТАЄ гроші, а відхилення депозиту нічого не рухає.

   Третя підвкладка — перекази, що прийшли, але не сіли на жодну заявку.
   Вони теж чекають рішення людини, тому стоять поруч, а не окремою
   вкладкою десь збоку.
   ============================================================ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import s from './admin.module.css';
import {
  api, rub, when, statusLabel, WITHDRAW_STATUS_RU, type WatcherStatus,
  type AdminPayment, type AdminWithdraw,
} from './lib';
import { EMPTY_FILTER, Filters, passes, type ReqFilter } from './Filters';
import { UnmatchedTab } from './UnmatchedTab';
import { useAsk } from '../../src/ui/Ask';

function mmss(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

type Kind = 'deposit' | 'withdraw' | 'unmatched';

export function RequestsTab({ onPending }: { onPending?: (n: number) => void }) {
  const [kind, setKind] = useState<Kind>('deposit');
  const [deps, setDeps] = useState<AdminPayment[] | null>(null);
  const [wds, setWds] = useState<AdminWithdraw[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [fresh, setFresh] = useState(0);
  /* Продакшн это или нет — знает только сервер. Спрашиваем один раз:
     от этого зависит лишь наличие кнопки симуляции, и ошибка здесь
     ничего не ломает (в проде сам запрос всё равно получит 403). */
  const [dev, setDev] = useState(false);
  const ask = useAsk();

  /* Фільтри свої на кожну підвкладку: пошук по нашій адресі й по адресі
     гравця — це різні пошуки, і скидати один, перемкнувшись на інший,
     було б прикро. */
  const [depFilter, setDepFilter] = useState<ReqFilter>(EMPTY_FILTER);
  const [wdFilter, setWdFilter] = useState<ReqFilter>(EMPTY_FILTER);

  const load = useCallback(async () => {
    try {
      const [d, w] = await Promise.all([
        api<{ payments: AdminPayment[]; pending: number }>('/payments'),
        api<{ withdrawals: AdminWithdraw[]; pending: number }>('/withdrawals'),
      ]);
      setDeps(d.payments);
      setWds(w.withdrawals);
      // бейдж на вкладці — сумарно, бо обидва типи чекають на ту саму людину
      onPending?.(d.pending + w.pending);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [onPending]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api<WatcherStatus>('/watcher')
      .then((w) => setDev(w.dev))
      .catch(() => { /* не вышло — просто не показываем кнопку */ });
  }, []);

  useEffect(() => {
    const p = setInterval(() => void load(), 10_000);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(p); clearInterval(t); };
  }, [load]);

  const act = async (path: string, confirmText?: string, danger = false) => {
    if (confirmText && !(await ask.confirm(confirmText, danger))) return;
    setBusyId(path); setErr(null);
    try {
      await api(path, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  };

  const shownDeps = useMemo(
    () => (deps ?? []).filter((p) => passes(depFilter, p.amount, p.createdAt, p.address)),
    [deps, depFilter]);
  const shownWds = useMemo(
    () => (wds ?? []).filter((w) => passes(wdFilter, w.amount, w.createdAt, w.address)),
    [wds, wdFilter]);

  /* В счётчике «ждёт решения» и то, что бот уже нашёл: это ровно те
     заявки, где от админа что-то требуется (или вот-вот потребуется). */
  const depPending = (deps ?? [])
    .filter((p) => p.status === 'pending' || p.status === 'processing').length;
  const wdPending = (wds ?? []).filter((w) => w.status === 'pending').length;

  const sub = (id: Kind) => `${s.subTab} ${kind === id ? s.on : ''}`;

  return (
    <>
      <div className={s.head}>
        <h1>Заявки</h1>
        <button type="button" className={s.refresh} onClick={() => void load()}>Обновить</button>
      </div>

      <div className={s.subTabs}>
        <button type="button" className={sub('deposit')} onClick={() => setKind('deposit')}>
          Пополнения{depPending > 0 && <span className={s.dot}>{depPending}</span>}
        </button>
        <button type="button" className={sub('withdraw')} onClick={() => setKind('withdraw')}>
          Выводы{wdPending > 0 && <span className={s.dot}>{wdPending}</span>}
        </button>
        <button type="button" className={sub('unmatched')} onClick={() => setKind('unmatched')}>
          Непознанные{fresh > 0 && <span className={s.dot}>{fresh}</span>}
        </button>
      </div>

      {err && <div className={s.err}>{err}</div>}

      {kind === 'unmatched' ? <UnmatchedTab onFresh={setFresh} /> : kind === 'deposit' ? (
        <>
          <Filters
            value={depFilter}
            onChange={setDepFilter}
            shown={shownDeps.length}
            total={deps?.length ?? 0}
            addressLabel="Кошелёк приёма"
          />
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Игрок</th>
                  <th className={s.num}>₽</th>
                  <th className={s.num}>Монета</th>
                  <th>Сеть</th>
                  <th>Кошелёк приёма</th>
                  <th>Статус</th>
                  <th>Создана</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shownDeps.map((p) => (
                  <tr key={p.id}>
                    <td className={s.player} data-label="Игрок">
                      <div className="name">{p.player?.firstName || 'ID ' + p.telegramId}</div>
                      <div className="sub">
                        {p.player?.username ? '@' + p.player.username : 'ID ' + p.telegramId}
                      </div>
                    </td>
                    <td className={s.num} data-label="₽">{rub(p.amount)}</td>
                    <td className={s.num} data-label="Монета">
                      {p.usdtAmount} <span className={s.dim}>{(p.token ?? 'usdt').toUpperCase()}</span>
                      {p.rateApprox && (
                        <span className={s.approx} title={`Курс приблизный: ${rub(p.rate)} ₽ за USDT. Сверь сумму.`}>≈</span>
                      )}
                    </td>
                    <td data-label="Сеть">
                      {p.network ?? '—'}
                      {p.memo && <div className={s.dim}>memo: {p.memo}</div>}
                    </td>
                    <td data-label="Кошелёк приёма">
                      <div className={`${s.mono} ${s.wrapAny}`} style={{ maxWidth: 220 }}>{p.address}</div>
                      {p.addressLabel && <div className={s.dim}>{p.addressLabel}</div>}
                    </td>
                    <td data-label="Статус">
                      <span className={`${s.badge} ${s[p.status]}`}>{statusLabel(p)}</span>
                      {p.status === 'pending' && (
                        <div className={`${s.timer} ${p.expiresAt - now < 5 * 60000 ? s.urgent : ''}`}>
                          {mmss(p.expiresAt - now)}
                        </div>
                      )}
                      {/* Заявка в обработке: показываем, чего именно ждём.
                          Пока сеть не подтвердила — кнопку жать рано, и
                          видно почему, а не просто «нельзя». */}
                      {p.status === 'processing' && !p.confirmedAt && (
                        <div className={s.timer}>
                          сеть подтверждает{p.confirmAt && p.confirmAt > now
                            ? ` · ${mmss(p.confirmAt - now)}` : ''}
                        </div>
                      )}
                      {p.txid && (
                        <div className={s.paid} title={p.txid}>
                          перевод найден{p.paidAmount ? `: ${p.paidAmount}` : ''}
                          {p.confirmedAt && ', подтверждён сетью'}
                        </div>
                      )}
                      {p.adminNote && <div className={s.dim}>{p.adminNote}</div>}
                    </td>
                    <td data-label="Создана">{when(p.createdAt)}</td>
                    <td data-label="">
                      {p.status === 'pending' || p.status === 'processing' ? (
                        <div className={s.rowActions}>
                          {/* Только вне продакшна: подделать перевод и
                              посмотреть, что сделает бот, не тратя
                              реальных денег. Сервер запрещает это сам —
                              кнопка лишь не мозолит глаза в проде. */}
                          {dev && p.status === 'pending' && (
                            <button type="button" className={s.btnSm}
                              disabled={busyId !== null}
                              title="Подделать перевод на сумму заявки (только dev)"
                              onClick={() => void act(`/payments/${p.id}/simulate`)}>
                              Симулировать
                            </button>
                          )}
                          <button type="button" className={`${s.btnSm} ${s.ok}`}
                            disabled={busyId !== null}
                            onClick={() => void act(`/payments/${p.id}/approve`)}>Зачислить</button>
                          <button type="button" className={`${s.btnSm} ${s.no}`}
                            disabled={busyId !== null}
                            onClick={() => void act(`/payments/${p.id}/reject`, 'Отклонить заявку на депозит?', true)}>Отклонить</button>
                        </div>
                      ) : <span className={s.dim}>—</span>}
                    </td>
                  </tr>
                ))}
                {deps && shownDeps.length === 0 && (
                  <tr><td colSpan={8}><div className={s.empty}>
                    {deps.length ? 'Под фильтр ничего не подходит' : 'Заявок ещё не было'}
                  </div></td></tr>
                )}
                {!deps && !err && (
                  <tr><td colSpan={8}><div className={s.empty}>Загрузка…</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <p className={s.dim} style={{ marginBottom: 10 }}>
            Деньги у игрока уже списаны при создании заявки. «Выплачено» просто
            закрывает её, «Отклонить» — возвращает сумму на баланс.
          </p>
          <Filters
            value={wdFilter}
            onChange={setWdFilter}
            shown={shownWds.length}
            total={wds?.length ?? 0}
            addressLabel="Кошелёк игрока"
          />
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Игрок</th>
                  <th className={s.num}>₽</th>
                  <th className={s.num}>USDT</th>
                  <th>Куда отправить</th>
                  <th>Статус</th>
                  <th>Создана</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shownWds.map((w) => (
                  <tr key={w.id}>
                    <td className={s.player} data-label="Игрок">
                      <div className="name">{w.player?.firstName || 'ID ' + w.telegramId}</div>
                      <div className="sub">
                        {w.player?.username ? '@' + w.player.username : 'ID ' + w.telegramId}
                      </div>
                    </td>
                    <td className={s.num} data-label="₽">{rub(w.amount)}</td>
                    <td className={s.num} data-label="USDT">
                      {w.usdtAmount}
                      {w.rateApprox && (
                        <span className={s.approx} title={`Курс приблизный: ${rub(w.rate)} ₽ за USDT. Сверь сумму перед отправкой.`}>≈</span>
                      )}
                    </td>
                    <td data-label="Куда отправить">
                      <div className={`${s.mono} ${s.wrapAny}`} style={{ maxWidth: 220 }}>{w.address}</div>
                    </td>
                    <td data-label="Статус">
                      <span className={`${s.badge} ${s[w.status] ?? ''}`}>{WITHDRAW_STATUS_RU[w.status]}</span>
                      {w.adminNote && <div className={s.dim}>{w.adminNote}</div>}
                    </td>
                    <td data-label="Создана">{when(w.createdAt)}</td>
                    <td data-label="">
                      {w.status === 'pending' ? (
                        <div className={s.rowActions}>
                          <button type="button" className={`${s.btnSm} ${s.ok}`}
                            disabled={busyId !== null}
                            onClick={() => void act(`/withdrawals/${w.id}/approve`,
                              `Отправил ${w.usdtAmount} USDT на ${w.address}?`)}>Выплачено</button>
                          <button type="button" className={`${s.btnSm} ${s.no}`}
                            disabled={busyId !== null}
                            onClick={() => void act(`/withdrawals/${w.id}/reject`,
                              `Отклонить? ${rub(w.amount)} ₽ вернутся игроку на баланс.`, true)}>Отклонить</button>
                        </div>
                      ) : <span className={s.dim}>—</span>}
                    </td>
                  </tr>
                ))}
                {wds && shownWds.length === 0 && (
                  <tr><td colSpan={7}><div className={s.empty}>
                    {wds.length ? 'Под фильтр ничего не подходит' : 'Заявок на вывод ещё не было'}
                  </div></td></tr>
                )}
                {!wds && !err && (
                  <tr><td colSpan={7}><div className={s.empty}>Загрузка…</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {ask.dialog}
    </>
  );
}
