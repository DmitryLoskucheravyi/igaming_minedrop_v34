'use client';

/* ============================================================
   MONEY — сума з іконкою валюти.

   Був у трьох екземплярах: компонент у GameClient і по локальній
   функції `money()` у вікнах виведення та бонус-баю. Розмітка та сама,
   і саме тому копії й з'явились — простіше було написати п'ять рядків,
   ніж імпортувати. Далі вони почали б розходитись, як розійшлись
   `rub()` і `when()`.

   BUMP. Зміна суми має бути помітною, не відриваючи погляд від поля:
   число коротко штовхається й підсвічується напрямком (прийшло /
   пішло). Вмикається пропсом, бо смикатись має баланс і ставка, а не
   ціна покупки, яка просто написана на кнопці.
   ============================================================ */

import { useEffect, useRef, useState } from 'react';
import {
  CURRENCY_META, fmtAmount, fmtWhole,
  type CurrencyCode, type Rates,
} from '../lib/currency';

/** скільки клас живе на вузлі — стільки й триває анімація в CSS */
const BUMP_MS = 460;

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
       браузер анімацію не перезапускає. Два виграші поспіль швидше за
       BUMP_MS другий раз проходили б мовчки. */
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

interface Props {
  /** сума в базовій одиниці (₽) — перерахунок у валюту показу тут */
  rub: number;
  currency: CurrencyCode;
  rates: Rates;
  /** велика сума (баланс, ставка): у рублях ціле, без копійок */
  whole?: boolean;
  /** стежити за змінами й підсвічувати їх */
  bump?: boolean;
}

export function Money({ rub, currency, rates, whole, bump }: Props) {
  const meta = CURRENCY_META[currency];
  const s = whole ? fmtWhole(rub, currency, rates) : fmtAmount(rub, currency, rates);
  // хук викликаємо завжди — порядок хуків не може залежати від пропса
  const beat = useBump(bump ? rub : 0);
  return (
    <span className={'money' + (bump ? ' bump' + beat : '')}>
      {s}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={'cur-ico' + (meta.mono ? ' mono' : '')} src={meta.icon} alt="" />
    </span>
  );
}
