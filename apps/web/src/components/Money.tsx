'use client';

/* ============================================================
   COINS — сума зі значком коіна.

   BUMP. Зміна суми має бути помітною, не відриваючи погляд від поля:
   число коротко штовхається й підсвічується напрямком (прийшло /
   пішло). Вмикається пропсом, бо смикатись має баланс і ставка, а не
   ціна покупки, яка просто написана на кнопці.

   ROLL. Баланс не перескакує на нове число, а докручується до нього —
   як лічильник: +2 500 від щоденної нагороди мають відчуватись як
   надходження, а не як заміна цифр.
   ============================================================ */

import { useEffect, useRef, useState } from 'react';
import { COIN_ICON, fmtCoins } from '../lib/currency';

/** скільки клас живе на вузлі — стільки й триває анімація в CSS */
const BUMP_MS = 460;
/** скільки триває докручування числа */
const ROLL_MS = 650;

export function useBump(value: number): string {
  const prev = useRef(value);
  const [dir, setDir] = useState('');

  useEffect(() => {
    if (value === prev.current) return;
    const next = value > prev.current ? ' up' : ' down';
    prev.current = value;

    /* Спершу знімаємо клас на один кадр. Поставити той самий ' up'
       удруге недостатньо: React не ререндерить однакове значення, а
       якби й ререндерив — computed animation-name не змінюється, і
       браузер анімацію не перезапускає. */
    setDir('');
    let off: ReturnType<typeof setTimeout> | null = null;
    const raf = requestAnimationFrame(() => {
      setDir(next);
      off = setTimeout(() => setDir(''), BUMP_MS);
    });
    return () => { cancelAnimationFrame(raf); if (off) clearTimeout(off); };
  }, [value]);

  return dir;
}

/* Число, що докручується до цілі. Перший рендер — одразу ціль (крутити
   від нуля на старті гри було б шумом), далі — плавно від показаного. */
export function useRolling(value: number, enabled: boolean): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const shownRef = useRef(value);

  useEffect(() => {
    if (!enabled) { shownRef.current = value; setShown(value); return; }
    from.current = shownRef.current;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ROLL_MS);
      const e = 1 - Math.pow(1 - k, 3);
      const v = from.current + (value - from.current) * e;
      shownRef.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, enabled]);

  return shown;
}

export function CoinIcon({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={'cur-ico' + (className ? ' ' + className : '')} src={COIN_ICON} alt="" draggable={false} />;
}

interface Props {
  value: number;
  /** стежити за змінами: підсвічувати напрямок і докручувати число */
  bump?: boolean;
}

export function Coins({ value, bump }: Props) {
  const beat = useBump(bump ? value : 0);
  const shown = useRolling(value, !!bump);
  return (
    <span className={'money' + (bump ? ' bump' + beat : '')}>
      {fmtCoins(shown)}
      <CoinIcon />
    </span>
  );
}
