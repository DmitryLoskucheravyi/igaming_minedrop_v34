'use client';

/* ============================================================
   ПРОМОКОДЫ — надбавка к пополнению в процентах.

   Всего два поля: код и процент. Это не упрощение ради упрощения —
   каждое дополнительное условие (срок, лимит применений, минимальная
   сумма) это ещё одна причина, по которой игроку скажут «промокод не
   подходит», и ещё одно место, где админ этого не заметит.

   Два правила, которые видно прямо на экране, потому что объяснять их
   игрокам придётся именно отсюда:

     - надбавка приходит БОНУСНЫМИ деньгами и требует отыгрыша. Игрок
       эти деньги не заносил, поэтому вывести их можно только прокрутив.
       Иначе промокод — это банкомат: ввёл код, пополнил, снял;
     - процент замораживается в заявке в момент её создания. Выключил
       код или сменил процент — это про следующие заявки, а не про уже
       выданное обещание.
   ============================================================ */

import { useCallback, useEffect, useState } from 'react';
import s from './admin.module.css';
import { api, when, type AdminPromo } from './lib';
import { useAsk } from '../../src/ui/Ask';

interface Payload {
  promos: AdminPromo[];
  /** во сколько раз надо прокрутить надбавку — правило живёт на сервере */
  wagerX: number;
  maxPercent: number;
}

export function PromosTab() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [percent, setPercent] = useState('');
  /* Множество id кодов, чьё Вкл/Выкл сейчас в полёте: двойной клик по
     одному не отправит два запроса, а другие строки не блокируются. */
  const [rowBusy, setRowBusy] = useState<ReadonlySet<string>>(() => new Set());
  const ask = useAsk();

  const load = useCallback(async () => {
    try {
      setData(await api<Payload>('/promos'));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    const n = Number(percent);
    if (!code.trim() || !Number.isFinite(n) || n <= 0) return;
    setBusy(true); setErr(null);
    try {
      await api('/promos', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim(), percent: Math.round(n) }),
      });
      setCode(''); setPercent('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const mark = (id: string, on: boolean) => setRowBusy((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const toggle = async (p: AdminPromo) => {
    mark(p.id, true); setErr(null);
    try {
      await api(`/promos/${p.id}`, {
        method: 'POST',
        body: JSON.stringify({ active: !p.active }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { mark(p.id, false); }
  };

  const editPercent = async (p: AdminPromo) => {
    const raw = await ask.prompt(
      `Процент для ${p.code}`, 'Сколько % от пополнения уйдёт бонусом', String(p.percent));
    if (raw === null) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) { setErr('Процент должен быть числом больше нуля'); return; }
    mark(p.id, true); setErr(null);
    try {
      await api(`/promos/${p.id}`, {
        method: 'POST',
        body: JSON.stringify({ percent: Math.round(n) }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { mark(p.id, false); }
  };

  const remove = async (p: AdminPromo) => {
    if (!(await ask.confirm(
      `Удалить промокод ${p.code}? На уже созданные заявки это не влияет — ` +
      'процент в них зафиксирован.', true))) return;
    mark(p.id, true); setErr(null);
    try {
      await api(`/promos/${p.id}/delete`, { method: 'POST', body: '{}' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { mark(p.id, false); }
  };

  const promos = data?.promos ?? [];
  const canAdd = !busy && code.trim().length >= 2 && Number(percent) > 0;

  return (
    <>
      <div className={s.head}>
        <h1>Промокоды</h1>
      </div>

      {err && <div className={s.err}>{err}</div>}

      <p className={s.dim} style={{ marginBottom: 12 }}>
        Игрок вводит код при пополнении. Когда заявку подтвердят, ему начислят
        <b> процент от суммы пополнения</b> — <b>бонусными</b> деньгами, с отыгрышем
        x{data?.wagerX ?? 10}. Процент фиксируется в заявке в момент её создания:
        выключение кода не отменяет уже выданное обещание.
      </p>

      <div className={s.addrForm}>
        <input
          className={s.input}
          placeholder="КОД — латиница, цифры, дефис"
          value={code}
          maxLength={32}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
        />
        <input
          className={`${s.input} ${s.short}`}
          placeholder="% бонуса"
          inputMode="numeric"
          value={percent}
          onChange={(e) => setPercent(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
        />
        <button type="button" className={s.confirm} disabled={!canAdd} onClick={() => void add()}>
          {busy ? '…' : 'Добавить'}
        </button>
      </div>

      {promos.length === 0 ? (
        <div className={s.empty}>Промокодов нет</div>
      ) : (
        <div className={s.addrList}>
          {promos.map((p) => (
            <div key={p.id} className={`${s.addrRow} ${p.active ? '' : s.off}`}>
              <div className={s.addrMain}>
                <div className={s.mono}>{p.code}</div>
                <div className={s.addrMeta}>
                  <span>+{p.percent}% к пополнению</span>
                  <span>{p.used > 0 ? `применён ${p.used} раз` : 'ещё не применялся'}</span>
                  {p.granted > 0 && <span>выдано {p.granted} ₽ бонусом</span>}
                  <span>заведён {when(p.createdAt)}</span>
                </div>
              </div>
              <div className={s.addrSide}>
                <span className={`${s.badge} ${p.active ? s.approved : s.expired}`}>
                  {p.active ? 'работает' : 'выключен'}
                </span>
                <div className={s.rowActions}>
                  <button type="button" className={s.btnSm} disabled={rowBusy.has(p.id)}
                    onClick={() => void toggle(p)}>
                    {p.active ? 'Выкл' : 'Вкл'}
                  </button>
                  <button type="button" className={s.btnSm} disabled={rowBusy.has(p.id)}
                    onClick={() => void editPercent(p)}>
                    Процент
                  </button>
                  <button type="button" className={`${s.btnSm} ${s.no}`} disabled={rowBusy.has(p.id)}
                    onClick={() => void remove(p)}>
                    Удалить
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {ask.dialog}
    </>
  );
}
