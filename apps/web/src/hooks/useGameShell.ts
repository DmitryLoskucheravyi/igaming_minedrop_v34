'use client';

/* ============================================================
   ОБОЛОНКА ГРИ — дрібні шматки стану, які не належать розмітці.

   Окремі хуки, а не один «стан HUD»: відкрите вікно й позначки «є що
   забрати» не мають нічого спільного, крім того, що всі знадобились
   одному компоненту.
   ============================================================ */

import { useCallback, useEffect, useState } from 'react';
import { Api } from '../lib/api';

/* ---- яке вікно відкрите ----
   Одне поле замість купи прапорців: незалежні були описують і стани,
   яких не буває, — два вікна поверх одного. */
export type ModalId = 'daily' | 'fair' | 'buy' | 'wheel' | 'ref' | 'spins';

export function useModal() {
  const [modal, setModal] = useState<ModalId | null>(null);
  const open = useCallback((id: ModalId) => setModal(id), []);
  const close = useCallback(() => setModal(null), []);
  return { modal, open, close };
}

/* Чи доступний прокрут колеса. Окремий тихий запит: не вийшов —
   просто не світимо крапку, бо це прикраса меню, а не умова гри. */
export function useWheelBadge() {
  const [ready, setReady] = useState(false);

  const check = useCallback(() => {
    void Api.wheel().then((w) => setReady(w.ready)).catch(() => {});
  }, []);

  useEffect(() => { check(); }, [check]);

  return { ready, check, setReady };
}

/* Щоденна нагорода. Питаємо на старті: доступна — вікно відкривається
   саме (onReady), і далі світиться позначка на кнопці подарунка, доки
   нагороду не заберуть. Нагорода, про яку не сказали, — не нагорода. */
export function useDailyBadge(onReady: () => void) {
  const [ready, setReady] = useState(false);
  const [day, setDay] = useState(0);

  useEffect(() => {
    let alive = true;
    Api.daily()
      .then((d) => {
        if (!alive) return;
        setReady(d.ready);
        setDay(d.day);
        if (d.ready) onReady();
      })
      .catch(() => {});
    return () => { alive = false; };
    // лише на старті: повторно відкривати вікно саме по собі не треба
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ready, day, setReady, setDay };
}
