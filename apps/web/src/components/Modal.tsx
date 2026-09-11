'use client';

/* ============================================================
   MODAL — спільна оболонка для вікон гри (депозит, чесність,
   історія платежів).

   Закривається трьома звичними способами: хрестик, клавіша Esc,
   клік по затемненню поза вікном. Раніше працював лише хрестик —
   на телефоні це відчувалось як пастка, бо решта інтерфейсу
   (включно з адмінкою) закривається саме тапом повз вікно.

   Esc іде через спільний стек шарів (src/ui/overlay), а не через
   власний слухач: поки вікно одне, різниці немає, але коли поверх
   нього стоїть підтвердження, одне натискання закривало обидва.

   Закриття по фону повішено на mousedown, а не на click: інакше
   виділення тексту, розпочате ВСЕРЕДИНІ вікна (наприклад, адреса
   гаманця) і відпущене за його межами, рахувалось би як клік по
   фону й закривало вікно посеред копіювання.

   ЗАКРИТТЯ МАЛЮЄМО САМІ. Вікно з'являється анімацією, а зникало б
   ривком: батько просто перестає його рендерити. Тому тут є власний
   стан `closing` — він вішає клас, під який CSS програє зворотні
   кадри, і аж потім віддає onClose нагору. Затримка мусить збігатися
   з тривалістю modal-out у globals.css.

   children може бути функцією: вона отримує `close` і закриває вікно
   ТИМ САМИМ шляхом, з анімацією. Без цього дія всередині вікна
   (купівля бонуски) знімала стан у батька, і вікно зникало ривком,
   тоді як хрестик поруч закривав його плавно.
   ============================================================ */

import {
  useCallback, useEffect, useRef, useState,
  type ReactNode,
} from 'react';
import { useEscape, useFocusTrap } from '../ui/overlay';

/** має відповідати --t (.16s) у tokens.css + запас на кадр */
const CLOSE_MS = 180;

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode | ((close: () => void) => ReactNode);
  /** вікно без власної рамки, тла й видимого заголовка */
  bare?: boolean;
}

export function Modal({ title, onClose, children, bare }: Props) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    // подвійний виклик (Esc під час анімації) не має перезапускати таймер
    if (timer.current) return;
    setClosing(true);
    timer.current = setTimeout(onClose, CLOSE_MS);
  }, [onClose]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEscape(close);
  useFocusTrap(box);

  return (
    <div
      className={'modal' + (closing ? ' closing' : '')}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        className={'modalbox' + (bare ? ' bare' : '')}
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* bare — вікно без власної рамки й заголовка: усе це вже
            намальоване на самому вмісті (картка бонус бая). Назва
            лишається в розмітці для читалок, просто не показується. */}
        <div className="modalhead">
          <h2 className={bare ? 'sr-only' : undefined}>{title}</h2>
          <button type="button" className="x" onClick={close} aria-label="Закрыть">
            {/* У безрамковому вікні хрестик мусить читатись поверх
                намальованої картки, тому він піксельний і великий — так
                само складений із квадратів, як і решта арту. Звичайним
                вікнам лишається символ: там він стоїть на рівному тлі. */}
            {bare
              ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" className="x-pix">
                  <path
                    d="M2 2h4v4H2zM6 6h4v4H6zM10 10h4v4h-4zM14 14h4v4h-4zM18 18h4v4h-4z
                       M18 2h4v4h-4zM14 6h4v4h-4zM6 14h4v4H6zM2 18h4v4H2z"
                  />
                </svg>
              )
              : '✕'}
          </button>
        </div>
        {typeof children === 'function' ? children(close) : children}
      </div>
    </div>
  );
}
