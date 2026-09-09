'use client';

/* ============================================================
   ASK — свої підтвердження й поле вводу замість confirm() і prompt().

   Нативні діалоги малює браузер: вони світлі в темній CRM, у різних
   браузерах різні, у деяких (і в iOS-вебв'ю) їх узагалі можна вимкнути
   назавжди галочкою «більше не показувати» — і тоді підтвердження
   мовчки перестане працювати, а видалення почне спрацьовувати одразу.
   Для дій, що рухають гроші, це неприйнятно.

   Обидва повертають Promise, тому виклик лишається таким самим
   послідовним, як був із confirm().
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from 'react';
import s from './admin.module.css';

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

  useEffect(() => {
    if (!state) return;
    setValue(state.input?.value ?? '');
    // фокус у поле — те, що нативний prompt робив сам
    const t = setTimeout(() => field.current?.select(), 30);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); state.resolve(null); onDone(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state, onDone]);

  if (!state) return null;

  const close = (v: string | boolean | null) => { state.resolve(v); onDone(); };
  const ok = () => close(state.input ? value : true);

  return (
    <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <form
        className={s.modal}
        onSubmit={(e) => { e.preventDefault(); ok(); }}
      >
        <h2>{state.text}</h2>

        {state.input && (
          <>
            <label className={s.label} htmlFor="ask-input">{state.input.label}</label>
            <input
              id="ask-input"
              ref={field}
              className={s.input}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={60}
            />
          </>
        )}

        <div className={s.actions}>
          <button type="submit" className={state.danger ? `${s.confirm} ${s.confirmDanger}` : s.confirm}>
            {state.input ? 'Сохранить' : state.danger ? 'Да, продолжить' : 'Подтвердить'}
          </button>
          <button type="button" className={s.cancel} onClick={() => close(null)}>Отмена</button>
        </div>
      </form>
    </div>
  );
}
