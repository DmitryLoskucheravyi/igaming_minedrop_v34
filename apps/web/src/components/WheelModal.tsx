'use client';

/* ============================================================
   КОЛЕСО ЩОДЕННОГО БОНУСУ.

   Один прокрут при першому вході, далі один на добу. ПРИЗ ВИРІШУЄ
   СЕРВЕР: кнопка спершу питає його, і лише отримавши відповідь, колесо
   починає крутитись — анімація просто доводить стрілку до вже відомого
   сектора. Через це «перекрутити, поки не сподобається» неможливо, а
   гроші на балансі з'являються навіть якщо вкладку закрити посеред
   обертання.

   Сектори теж приходять із сервера. Своєї копії списку тут немає
   навмисно: розійшлася б вона з математикою — і колесо показувало б
   одне, а нараховувало інше.

   ---- ПРО ВИГЛЯД ----
   Усе, що світиться й рухається, зроблено ТІЛЬКИ css-анімаціями поверх
   статичного svg: жодного кадру не малює javascript. Причина практична
   — колесо крутиться 4 секунди підряд на телефоні, і покадровий
   перерахунок у React тут гарантовано дав би ривки саме в той момент,
   коли гравець дивиться на екран найуважніше.

   Стан «що зараз відбувається» передається одним класом на обгортці
   (idle / spinning / landed), а лампи, стрілка й сектори самі знають,
   як на нього реагувати. Тому додати стан — це правило в css, а не
   нова гілка в розмітці.
   ============================================================ */

import { useEffect, useRef, useState } from 'react';
import { Api, type WheelState } from '../lib/api';
import { Modal } from './Modal';

/* Скільки повних обертів накрутити до посадки. Менше трьох — і кидок
   читається як смикання, більше шести — гравець чекає даремно. */
const TURNS = 5;
const SPIN_SEC = 4.2;

/* Лампи по обіднику. 24 — вистачає, щоб дуга читалась як суцільний
   ланцюжок вогнів, і не стільки, щоб дрібний екран перетворився на
   кашу з крапок. */
const BULBS = 24;

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : m > 0 ? `${m} мин` : `${s} сек`;
}

/* Сектор як SVG-шлях: клин від центру. Кут 0 — вгору, далі за
   годинниковою, щоб збігалося зі стрілкою зверху. */
function sector(i: number, n: number, r: number): string {
  const seg = (Math.PI * 2) / n;
  const a0 = -Math.PI / 2 + i * seg;
  const a1 = a0 + seg;
  const x0 = 100 + Math.cos(a0) * r, y0 = 100 + Math.sin(a0) * r;
  const x1 = 100 + Math.cos(a1) * r, y1 = 100 + Math.sin(a1) * r;
  return `M100 100 L${x0.toFixed(2)} ${y0.toFixed(2)} `
    + `A${r} ${r} 0 ${seg > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

interface Props {
  onClose: () => void;
  /** приз нараховано — перечитати баланс */
  onWon?: () => void;
}

export function WheelModal({ onClose, onWon }: Props) {
  const [state, setState] = useState<WheelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [angle, setAngle] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [won, setWon] = useState<
    { label: string; index: number; rub: number; spins: number } | null>(null);
  const [left, setLeft] = useState(0);
  /* Поправка до годинника телефону: він буває збитий на години, а
     таймер рахується як nextAt - now. Беремо різницю з серверним
     часом, як у вікні поповнення. */
  const skew = useRef(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    Api.wheel()
      .then((w) => {
        if (!alive) return;
        skew.current = Date.now() - w.now;
        setState(w);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      /* Вікно можуть закрити посеред обертання. Таймер посадки тоді
         вистрелив би в неіснуючий компонент — знімаємо його. Приз від
         цього не втрачається: він уже нарахований на сервері. */
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  /* Таймер до наступного прокруту. Тікає лише коли є чого чекати. */
  useEffect(() => {
    if (!state?.nextAt || state.ready) return;
    const tick = () => setLeft(state.nextAt! - (Date.now() - skew.current));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state]);

  const spin = async () => {
    if (spinning || !state?.ready) return;
    setSpinning(true);
    setError(null);
    try {
      const res = await Api.spinWheel();
      const n = state.prizes.length;
      const seg = 360 / n;
      /* Куди доїхати: центр виграшного сектора має стати під стрілкою
         (вона вгорі). Домотуємо до поточного кута ЗВЕРХУ, а не задаємо
         абсолютний — інакше друге обертання пішло б назад. */
      const target = TURNS * 360 - (res.index * seg + seg / 2);
      const base = Math.ceil(angle / 360) * 360;
      setAngle(base + target);
      timer.current = window.setTimeout(() => {
        setWon({
          label: res.prize.label, index: res.index,
          rub: res.prize.rub, spins: res.prize.spins,
        });
        setState(res.state);
        setSpinning(false);
        onWon?.();
      }, SPIN_SEC * 1000);
    } catch (e) {
      setError((e as Error).message);
      setSpinning(false);
    }
  };

  const prizes = state?.prizes ?? [];
  const seg = prizes.length ? 360 / prizes.length : 0;
  const phase = spinning ? 'spinning' : won ? 'landed' : state?.ready ? 'idle' : 'waiting';

  return (
    <Modal title="Колесо удачи" onClose={onClose}>
      {error && <p className="err">{error}</p>}

      <div className={'wheel-stage ' + phase}>
        {/* Промені з-під колеса на момент виграшу. Лежать ПІД ним і
            видні лише в стані landed. */}
        <div className="wheel-rays" aria-hidden="true" />

        <div className="wheel-pin" aria-hidden="true">
          <svg viewBox="0 0 24 30">
            <path d="M12 30 L2 8 A12 12 0 0 1 22 8 Z" className="pin-body" />
            <circle cx="12" cy="9" r="3.5" className="pin-gem" />
          </svg>
        </div>

        <svg
          className="wheel"
          viewBox="0 0 200 200"
          style={{
            transform: `rotate(${angle}deg)`,
            transition: spinning ? `transform ${SPIN_SEC}s cubic-bezier(.16,.72,.12,1)` : 'none',
          }}
        >
          <defs>
            <linearGradient id="wd-a" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#25334f" />
              <stop offset="100%" stopColor="#161f31" />
            </linearGradient>
            <linearGradient id="wd-b" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#33507f" />
              <stop offset="100%" stopColor="#1e3053" />
            </linearGradient>
            <linearGradient id="wd-jack" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ffd34d" />
              <stop offset="100%" stopColor="#b26f18" />
            </linearGradient>
            <linearGradient id="wd-win" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5cd97a" />
              <stop offset="100%" stopColor="#1c6b38" />
            </linearGradient>
            <radialGradient id="wd-hub" cx="38%" cy="32%">
              <stop offset="0%" stopColor="#46566a" />
              <stop offset="100%" stopColor="#141b23" />
            </radialGradient>
            <linearGradient id="wd-rim" x1="0" y1="0" x2="0.3" y2="1">
              <stop offset="0%" stopColor="#5a6b80" />
              <stop offset="45%" stopColor="#2b3644" />
              <stop offset="100%" stopColor="#4a5a6d" />
            </linearGradient>
            <radialGradient id="wd-glass" cx="32%" cy="22%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity=".16" />
              <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* обідник */}
          <circle cx="100" cy="100" r="97" className="wheel-rim" />

          {prizes.map((p, i) => {
            const jackpot = p.id.startsWith('spins');
            const mid = -90 + i * seg + seg / 2;
            const rad = (mid * Math.PI) / 180;
            const lx = 100 + Math.cos(rad) * 58;
            const ly = 100 + Math.sin(rad) * 58;
            /* Підпис лежить уздовж радіуса, а радіус на нижній половині
               колеса дивиться вниз — там текст виходив догори дриґом.
               Дорозвертаємо його на 180°: читається він тоді «до
               центру», зате читається. */
            const turn = ((mid + 90) % 360 + 360) % 360;
            const rot = (mid + 90) + (turn > 90 && turn < 270 ? 180 : 0);
            /* Довгу назву ріжемо на два рядки по першому пробілу:
               «5 фриспинов» в один рядок не влазить у сектор і
               наповзає на обідник. «10 ₽» лишається як є. */
            const cut = p.label.length > 7 ? p.label.indexOf(' ') : -1;
            const lines = cut > 0 ? [p.label.slice(0, cut), p.label.slice(cut + 1)] : [p.label];
            const fill = won?.index === i
              ? 'url(#wd-win)'
              : jackpot ? 'url(#wd-jack)' : `url(#wd-${i % 2 ? 'a' : 'b'})`;
            return (
              <g key={p.id + i} className={'wheel-sector' + (won?.index === i ? ' win' : '')}>
                <path d={sector(i, prizes.length, 88)} fill={fill} className="sector-face" />
                <text
                  x={lx} y={ly}
                  transform={`rotate(${rot} ${lx} ${ly})`}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className={'wheel-label' + (jackpot ? ' jack' : '')}
                >
                  {lines.map((ln, k) => (
                    <tspan key={ln + k} x={lx} dy={k === 0 ? (lines.length > 1 ? -6 : 0) : 12}>
                      {ln}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}

          {/* блік поверх секторів — дає відчуття опуклого скла */}
          <circle cx="100" cy="100" r="88" fill="url(#wd-glass)" pointerEvents="none" />

          {/* лампи. Затримка анімації в кожної своя, тому вогні біжать
              по колу, а не блимають усі разом. */}
          {Array.from({ length: BULBS }, (_, i) => {
            const a = (i / BULBS) * Math.PI * 2 - Math.PI / 2;
            return (
              <circle
                key={i}
                className="wheel-bulb"
                cx={100 + Math.cos(a) * 92.5}
                cy={100 + Math.sin(a) * 92.5}
                r="2.6"
                style={{ animationDelay: `${(i / BULBS).toFixed(3)}s` }}
              />
            );
          })}

          <circle cx="100" cy="100" r="17" fill="url(#wd-hub)" className="wheel-hub" />
          <circle cx="100" cy="100" r="6" className="wheel-hub-dot" />
        </svg>
      </div>

      {won && (
        <div className="wheel-prize" key={won.index}>
          <span className="wheel-prize-label">{won.label}</span>
          <span className="wheel-prize-sub">
            {won.spins
              ? `зачислено · сыграют по ${state?.freeBet ?? 0} ₽ за прокрут`
              : 'зачислено на баланс'}
          </span>
        </div>
      )}

      {!state && !error && <p className="hint">Загрузка…</p>}

      {state && !won && (
        state.ready
          ? (
            <button
              type="button"
              className="btn primary wide wheel-go"
              disabled={spinning}
              onClick={spin}
            >
              {spinning ? 'Крутится…' : state.first ? 'Крутить — подарок за вход' : 'Крутить'}
            </button>
          )
          : <p className="hint wheel-wait">Следующий прокрут через {mmss(left)}</p>
      )}

      {state && won && !state.ready && (
        <p className="hint wheel-wait">Следующий прокрут через {mmss(left)}</p>
      )}

      {!!state?.freeSpins && (
        <p className="wheel-spins">
          Бесплатных прокрутов: <b>{state.freeSpins}</b>
        </p>
      )}
    </Modal>
  );
}
