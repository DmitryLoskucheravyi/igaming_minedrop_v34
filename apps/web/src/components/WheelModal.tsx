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



function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} ч ${m} мин` : m > 0 ? `${m} мин` : `${s} сек`;
}

/* Радіус секторів і розмір обідника — у одиницях viewBox (200).

   Числа не з голови: в обідника (public/wheel/колесо.png, 1254x1254)
   заміряно прозорий отвір і зовнішній край — кільце займає радіуси
   453..616 з 627, тобто 0.72..0.98 півсторони.

   Обідник НАВМИСНО більший за кадр (220 при viewBox 200): його отвір —
   це все вікно, крізь яке видно сектори, і при 202 сталеве кільце
   з'їдало верхівки клинів разом із монетами. Ціна — зовнішній край
   вилазить за viewBox приблизно на 8 одиниць, тому в .wheel стоїть
   overflow: visible. Сцена від цього не роз'їжджається: промені під
   колесом і так лежать із inset -14%.

   220 — це СТЕЛЯ, а не смак. Заміряно по альфі самого обідника: перші
   зубці кільця йдуть із 0.720 півсторони, а суцільний метал — аж із
   0.775. Сектор мусить діставати до 0.775, інакше в щілину світиться
   підложка; при 86 це дає рівно 220 (перевірено рендером на кислотному
   фоні: 218 і 220 чисті, 222 уже тече). Тягнути обідник далі можна
   тільки разом із сектором, а тоді частка видимого клина не росте —
   вона впирається в 0.720/0.775 ≈ 92%, і це вже властивість самого
   малюнка рамки, а не чисел тут.

   Сектори НАВМИСНО більші за отвір — вони мають заходити ПІД кільце.
   Розмір підібрано не на око: рендер із радіусом 78 і 86 порівняно
   поруч, і на 78 між краєм сектора й золотим обідком лишалася темна
   смуга — крізь неї світилася підложка (в обідника м'яка напівпрозора
   тінь усередину, тож «діра» насправді менша за свій різкий край). На
   86 сектор лягає впритул, а надлишок ховається під кільцем. */
const SECTOR_R = 86;
const RIM_SIZE = 220;
/* Втулка. 42 підібрано рендером поруч із колесом: на 34 заклепки на ній
   тиснуться одна до одної, на 50 вона починає забивати сектори. */
const HUB_SIZE = 42;

/* Сектор — НАМАЛЬОВАНА КАРТИНКА (public/wheel), а не фігура в коді.

   Файли зроблені scripts/wheel-wedges.mjs: він знімає з вихідників
   запечену шахматку, вирівнює всі сектори до однієї геометрії
   (вершина внизу посередині, радіус = висота картинки) і обрізає рівно
   по куту 360/N. Тому тут досить покласти картинку вершиною в центр
   колеса й повернути — щілин між секторами не буде за побудовою.

   Ключ — id призу з сервера, тож новий приз це новий файл із такою
   самою назвою, і більше нічого. */
const WEDGE: Record<string, string> = {
  cash10: '/wheel/cash10.png',
  cash25: '/wheel/cash25.png',
  cash50: '/wheel/cash50.png',
  cash100: '/wheel/cash100.png',
  spins5: '/wheel/spins5.png',
};

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

        {/* Стрілка теж намальована (public/wheel/pin.png): вістря в неї
            внизу посередині, тому обертання «клацання» крутимо навколо
            верхньої частини — інакше сіпався б сам кінчик. */}
        <div className="wheel-pin" aria-hidden="true">
          <img src="/wheel/pin.png" alt="" draggable={false} />
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
            <radialGradient id="wd-glass" cx="32%" cy="22%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity=".16" />
              <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
          </defs>

          {prizes.map((p, i) => (
            /* Сектор — тільки картинка. Підписів поверх арту немає
               навмисно: на секторі й так намальовано, що це за приз, а
               обертовий текст половину часу стояв догори дриґом і лізь
               на монети. Що саме випало, скаже плашка після зупинки. */
            <g key={p.id + i} className={'wheel-sector' + (won?.index === i ? ' win' : '')}>
              {/* Картинка кладеться вершиною рівно в центр колеса
                  (тому y = 100 - 88, а не 100) і повертається навколо
                  нього ж. preserveAspectRatio вимкнено: клин уже
                  обрізаний під потрібний кут, розтягувати його по
                  пропорціях не можна. */}
              <image
                href={WEDGE[p.id]}
                x={100 - SECTOR_R / 2}
                y={100 - SECTOR_R}
                width={SECTOR_R}
                height={SECTOR_R}
                preserveAspectRatio="none"
                transform={`rotate(${i * seg} 100 100)`}
                className="sector-face"
              />
            </g>
          ))}

          {/* блік поверх секторів — дає відчуття опуклого скла */}
          <circle cx="100" cy="100" r="88" fill="url(#wd-glass)" pointerEvents="none" />

          {/* ОБІДНИК — намальований, кладеться ПОВЕРХ секторів: у нього
              прозорий центр, крізь який вони й видно. Лампи та рівчаки
              намальовані в ньому ж, тому кола в коді більше немає. */}
          <image
            href="/wheel/колесо.png"
            x={100 - RIM_SIZE / 2}
            y={100 - RIM_SIZE / 2}
            width={RIM_SIZE}
            height={RIM_SIZE}
            className="wheel-rim"
          />

          {/* ВТУЛКА — намальована (public/wheel/центр.png). Лежить
              ВСЕРЕДИНІ svg, тобто крутиться разом із колесом: так і має
              бути, вона ж на нього насаджена.

              Саме тому картинку проганяють через scripts/wheel-hub.mjs:
              у присланому файлі коло сиділо повз центр полотна, і на
              прокруті це читалось би як биття. */}
          <image
            href="/wheel/центр.png"
            x={100 - HUB_SIZE / 2}
            y={100 - HUB_SIZE / 2}
            width={HUB_SIZE}
            height={HUB_SIZE}
            className="wheel-hub"
          />
        </svg>
      </div>

      {won && (
        /* Єдине місце, де приз названо словами — на секторах підписів
           більше немає. Тому тут і підводка, і сума, і що з нею сталось. */
        <div className="wheel-prize" key={won.index}>
          <span className="wheel-prize-cap">Выпало</span>
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
