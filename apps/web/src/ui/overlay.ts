'use client';

/* ============================================================
   ШАРИ ПОВЕРХ ІНТЕРФЕЙСУ — Esc і фокус.

   ESC. Кожне вікно раніше вішало власний слухач на document, і поки
   шар був один, це працювало. Щойно поверх вікна виведення стало
   підтвердження скасування, одне натискання Esc гасило ОБИДВА:
   діалог відповідав «ні», а вікно під ним закривалось разом з ним.
   Тому слухач тепер один на застосунок, а шари складаються в стек —
   Esc отримує тільки верхній.

   ФОКУС. У вікна з aria-modal фокус мусить бути замкнений: інакше
   Tab іде «за» вікно, у кнопки під затемненням, які видно, але яких
   для читалки з екрана вже не існує. Повертаємо фокус туди, звідки
   вікно відкрили, — інакше після закриття він падає на <body> і
   наступний Tab починає обхід з початку сторінки.
   ============================================================ */

import { useEffect, useRef, type RefObject } from 'react';

type Handler = () => void;

const stack: Handler[] = [];
let bound = false;

const onKeyDown = (e: KeyboardEvent) => {
  if (e.key !== 'Escape' || !stack.length) return;
  e.preventDefault();
  stack[stack.length - 1]();
};

function push(h: Handler): () => void {
  if (!bound && typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown);
    bound = true;
  }
  stack.push(h);
  return () => {
    /* lastIndexOf, а не indexOf: два однакові за посиланням обробники
       теоретично можливі, і зняти треба саме свій — верхній. */
    const i = stack.lastIndexOf(h);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Esc закриває цей шар, поки він верхній. */
export function useEscape(onEscape: Handler, active = true): void {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!active) return;
    return push(() => cb.current());
  }, [active]);
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Замикає Tab усередині вузла й повертає фокус після закриття. */
export function useFocusTrap(box: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const el = box.current;
    if (!el) return;

    const prev = document.activeElement as HTMLElement | null;
    /* Якщо всередині вже є куди стати (поле вводу) — не заважаємо:
       вікна самі вирішують, що має бути під курсором. Інакше беремо
       фокус на саму коробку, щоб Esc і Tab працювали одразу. */
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      /* Пастка може бути вкладена в пастку (діалог поверх вікна).
         Зупиняємо подію, щоб зовнішня не переставила фокус слідом за
         внутрішньою — інакше Tab у діалозі стрибав би у вікно під ним. */
      e.stopPropagation();
      const first = items[0], last = items[items.length - 1];
      const now = document.activeElement;
      if (e.shiftKey && (now === first || now === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && now === last) { e.preventDefault(); first.focus(); }
    };

    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      // вузол уже зникає — повертаємо фокус на кнопку, що відкрила вікно
      prev?.focus?.({ preventScroll: true });
    };
  }, [box, active]);
}
