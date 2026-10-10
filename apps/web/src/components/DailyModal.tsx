'use client';

/* ============================================================
   ЩОДЕННА НАГОРОДА — поповнення коінів + серія заходів.

   Календар на 30 днів: пройдені дні серії погашені галочкою, сьогоднішній
   світиться, майбутні показують, скільки чекає попереду, — саме це й
   тягне повернутись завтра. Кожен сьомий день виділено як віху.

   Вікно нічого не рахує: який сьогодні день серії й скільки дадуть,
   вирішує сервер. Тут лише показ і одна кнопка.
   ============================================================ */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Api, type DailyClaim, type DailyState } from '../lib/api';
import { haptic } from '../lib/telegram';
import { left as leftStr } from '../lib/format';
import { Modal } from './Modal';
import { CoinIcon, Coins } from './Money';
import { PixIcon } from '../ui/PixIcon';

interface Props {
  onClose: () => void;
  /** нагороду забрано — перечитати баланс і погасити позначку */
  onClaimed: (c: DailyClaim) => void;
}

/** скільки монет розлітається з кнопки */
const BURST = 16;

/** 1000 -> 1K, 12 500 -> 12.5K: у клітинці календаря місця на 4 знаки */
const short = (n: number): string =>
  n >= 1000 ? `${+(n / 1000).toFixed(1)}K` : String(n);

export function DailyModal({ onClose, onClaimed }: Props) {
  const [state, setState] = useState<DailyState | null>(null);
  const [claim, setClaim] = useState<DailyClaim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leftMs, setLeftMs] = useState(0);
  /* Поправка до годинника телефону: таймер — це nextAt мінус «зараз», а
     годинник телефону буває збитий на години. */
  const skew = useRef(0);

  useEffect(() => {
    let alive = true;
    Api.daily()
      .then((d) => {
        if (!alive) return;
        skew.current = Date.now() - d.now;
        setState(d);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!state || state.ready) return;
    const tick = () => setLeftMs(state.nextAt - (Date.now() - skew.current));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state]);

  const take = async () => {
    if (busy || !state?.ready) return;
    setBusy(true);
    setError(null);
    try {
      const c = await Api.claimDaily();
      skew.current = Date.now() - c.state.now;
      setClaim(c);
      setState(c.state);
      haptic('win');
      onClaimed(c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /* Кути розльоту монет — один раз на вікно, а не на кожен рендер:
     інакше таймер, що тікає щосекунди, перетасовував би їх у польоті. */
  const burst = useMemo(() => Array.from({ length: BURST }, (_, i) => {
    const a = (i / BURST) * Math.PI * 2 + Math.random() * 0.4;
    const r = 90 + Math.random() * 70;
    return {
      '--bx': `${Math.cos(a) * r}px`,
      '--by': `${Math.sin(a) * r - 40}px`,
      '--bd': `${Math.random() * 0.12}s`,
      '--br': `${Math.random() * 540 - 270}deg`,
    } as React.CSSProperties;
  }), []);

  const day = state?.day ?? 1;
  const today = state ? state.rewards[day - 1] ?? 0 : 0;
  const tomorrow = state ? state.rewards[day % state.rewards.length] ?? 0 : 0;

  return (
    <Modal title="Ежедневная награда" onClose={onClose}>
      {error && <p className="err">{error}</p>}
      {!state && !error && <p className="hint">Загрузка…</p>}

      {state && (
        <div className="daily">
          <div className="daily-head">
            <span className="daily-flame"><PixIcon name="flame" /></span>
            <div className="daily-head-text">
              <span className="daily-streak">
                {state.ready ? `День ${day} серии` : `Серия: ${day} ${dayWord(day)}`}
              </span>
              <span className="daily-sub">
                Заходи каждый день — награда растёт. Пропустишь день, и серия начнётся заново.
              </span>
            </div>
          </div>

          <ol className="daily-grid" aria-label="Календарь серии">
            {state.rewards.map((r, i) => {
              const n = i + 1;
              /* «Пройдено» — дні серії ДО сьогоднішнього; якщо сьогодні вже
                 забрали, то й він. */
              const done = state.ready ? n < day : n <= day;
              const now = n === day;
              const milestone = n % 7 === 0 || n === state.rewards.length;
              return (
                <li
                  key={n}
                  className={'daily-cell'
                    + (done ? ' done' : '')
                    + (now ? ' now' : '')
                    + (now && state.ready ? ' ready' : '')
                    + (milestone ? ' mile' : '')}
                  style={{ '--i': i } as React.CSSProperties}
                >
                  <span className="daily-n">{n}</span>
                  <span className="daily-r">{short(r)}</span>
                  {done && <span className="daily-tick" aria-label="получено">✓</span>}
                </li>
              );
            })}
          </ol>

          <div className="daily-sum">
            <div className="daily-sum-row">
              <span>Ежедневное пополнение</span>
              <b>+<Coins value={state.refill} /></b>
            </div>
            <div className="daily-sum-row">
              <span>Бонус за день {day}</span>
              <b>+<Coins value={today} /></b>
            </div>
          </div>

          <div className="daily-cta">
            {claim && (
              <div className="daily-burst" aria-hidden="true">
                {burst.map((st, i) => (
                  <span key={i} className="daily-coin" style={st}><CoinIcon /></span>
                ))}
              </div>
            )}

            {state.ready ? (
              <button
                type="button"
                className="btn wide gold daily-go"
                disabled={busy}
                onClick={take}
              >
                {busy ? 'Забираю…' : <>Забрать +<Coins value={state.refill + today} /></>}
              </button>
            ) : (
              <>
                {claim && (
                  <div className="daily-got" key={claim.day}>
                    <span className="daily-got-cap">Получено</span>
                    <span className="daily-got-sum">+<Coins value={claim.total} /></span>
                  </div>
                )}
                <p className="hint daily-wait">
                  Следующая награда через <b>{leftStr(leftMs)}</b>
                  <span className="daily-next">
                    завтра +<Coins value={state.refill + tomorrow} />
                  </span>
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function dayWord(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return 'день';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'дня';
  return 'дней';
}
