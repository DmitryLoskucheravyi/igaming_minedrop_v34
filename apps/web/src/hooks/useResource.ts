'use client';

/* ============================================================
   USERESOURCE — «завантажити з сервера» одним рядком.

   Кожне вікно писало цю трійцю заново: data / error / loading, ефект
   на монтуванні, ручний setErr у catch. П'ять компонентів — п'ять
   майже однакових, але трохи різних реалізацій: десь помилка ковталась,
   десь лишалась стара після успішного перезавантаження, десь відповідь
   приходила вже після розмонтування й React лаявся на setState.

   Тут це один раз і правильно:
     - гонка відповідей вирішена лічильником, а не прапорцем: якщо
       reload викликали двічі, застаріла відповідь не перезапише свіжу;
     - після розмонтування нічого не пишеться;
     - помилка знімається успішним завантаженням сама.

   setData назовні є навмисно: створивши заявку, вікно вже має свіжу
   відповідь сервера, і другий запит по неї — зайвий обмін.
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> {
  data: T | null;
  error: string | null;
  /** true, поки жодної відповіді ще не було (не «йде будь-який запит») */
  loading: boolean;
  reload: () => Promise<void>;
  setData: (patch: (prev: T | null) => T | null) => void;
  setError: (m: string | null) => void;
}

export function useResource<T>(load: () => Promise<T>): Resource<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const alive = useRef(true);
  const seq = useRef(0);
  /* Завантажувач майже завжди приходить стрілкою прямо у виклик, тобто
     новий на кожен рендер. Тримаємо його в ref, щоб reload лишався
     стабільним і не перезапускав ефекти в тих, хто його викликає. */
  const fn = useRef(load);
  fn.current = load;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const next = await fn.current();
      if (!alive.current || my !== seq.current) return;
      setDataState(next);
      setError(null);
    } catch (e) {
      if (!alive.current || my !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current && my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const setData = useCallback((patch: (prev: T | null) => T | null) => {
    setDataState(patch);
  }, []);

  return { data, error, loading, reload, setData, setError };
}

/* Повторювати дію, поки виконується умова. Окремо від useResource, бо
   полінг потрібен не завжди й не в усіх: активну заявку опитують, а
   історію платежів — ні. */
export function usePoll(fn: () => void, ms: number, on: boolean): void {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => cb.current(), ms);
    return () => clearInterval(t);
  }, [ms, on]);
}

/* Годинник, який цокає тільки коли на нього дивляться. Таймер заявки
   інакше крутив би зайвий ререндер щосекунди у ВСІХ вікнах одразу. */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}
