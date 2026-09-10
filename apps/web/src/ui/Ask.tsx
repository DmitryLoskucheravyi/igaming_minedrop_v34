'use client';

/* ============================================================
   ASK — свої підтвердження й поле вводу замість confirm() і prompt().

   Нативні діалоги малює браузер: вони світлі в темній темі, у різних
   браузерах різні, у деяких (і в iOS-вебв'ю) їх узагалі можна вимкнути
   назавжди галочкою «більше не показувати» — і тоді підтвердження
   мовчки перестане працювати, а видалення почне спрацьовувати одразу.
   Для дій, що рухають гроші, це неприйнятно.

   Обидва повертають Promise, тому виклик лишається таким самим
   послідовним, як був із confirm().

   Живе в src/ui, а не в app/admin: тими самими діалогами користується
   і гра (скасування заявки на виведення). Через це й розмітка на
   глобальних класах globals.css, а не на модулі CRM — інакше половина
   застосунку не змогла б їх імпортувати.
   ============================================================ */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useEscape, useFocusTrap } from './overlay';

interface AskState {
  text: string;
  danger: boolean;
  /** якщо задано — це поле вводу, а не просто «так/ні» */
  input?: { label: string; value: string };
  resolve: (v: string | boolean | null) => void;
}

export function useAsk() {
  const [state, setState] = useState<AskState | null>(null);
  /* Резолвер ще не відповіданого запиту. Без нього другий виклик
     confirm()/prompt() до відповіді на перший просто замінював би
     state — і Promise першого виклику ніколи не резолвився б: await
     ask.confirm(...) там повис би назавжди. */
  const pending = useRef<AskState['resolve'] | null>(null);

  const open = useCallback((next: AskState) => {
    // старий запит ще без відповіді — рахуємо його скасованим і
    // резолвимо, перш ніж показати новий
    pending.current?.(null);
    pending.current = next.resolve;
    setState(next);
  }, []);

  const confirm = useCallback(
    (text: string, danger = false) => new Promise<boolean>((resolve) => {
      open({ text, danger, resolve: (v) => resolve(v === true) });
    }), [open]);

  const prompt = useCallback(
    (text: string, label: string, value = '') => new Promise<string | null>((resolve) => {
      open({ text, danger: false, input: { label, value },
             resolve: (v) => resolve(typeof v === 'string' ? v : null) });
    }), [open]);

  const dialog = <AskDialog state={state} onDone={() => { pending.current = null; setState(null); }} />;
  return { confirm, prompt, dialog };
}

function AskDialog({ state, onDone }: { state: AskState | null; onDone: () => void }) {
  const [value, setValue] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLFormElement>(null);
  /* Свій id на кожен екземпляр: діалогів у застосунку кілька (гра, три
     вкладки CRM), і фіксований "ask-input" дав би дубль id, щойно два
     з них опиняться в DOM одночасно — label показував би на чужий. */
  const inputId = useId();

  useEffect(() => {
    if (!state) return;
    setValue(state.input?.value ?? '');
    // фокус у поле — те, що нативний prompt робив сам
    const t = setTimeout(() => field.current?.select(), 30);
    return () => clearTimeout(t);
  }, [state]);

  /* Esc — через спільний стек: діалог відкривають ПОВЕРХ вікна, і
     власний слухач на document гасив би заодно й вікно під ним. */
  const cancel = useCallback(() => {
    if (!state) return;
    state.resolve(null);
    onDone();
  }, [state, onDone]);
  useEscape(cancel, !!state);
  useFocusTrap(box, !!state);

  if (!state) return null;

  const close = (v: string | boolean | null) => { state.resolve(v); onDone(); };
  const ok = () => close(state.input ? value : true);

  return (
    <div className="modal ask" onMouseDown={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <form
        className="modalbox ask-box"
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => { e.preventDefault(); ok(); }}
      >
        <h2>{state.text}</h2>

        {state.input && (
          <>
            <label className="dep-label" htmlFor={inputId}>{state.input.label}</label>
            <input
              id={inputId}
              ref={field}
              className="input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={60}
            />
          </>
        )}

        <div className="ask-actions">
          <button type="submit" className={'btn wide' + (state.danger ? ' danger' : '')}>
            {state.input ? 'Сохранить' : state.danger ? 'Да, продолжить' : 'Подтвердить'}
          </button>
          <button type="button" className="btn" onClick={() => close(null)}>Отмена</button>
        </div>
      </form>
    </div>
  );
}
