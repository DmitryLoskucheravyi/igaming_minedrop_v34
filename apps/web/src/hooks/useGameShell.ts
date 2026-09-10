'use client';

/* ============================================================
   ОБОЛОНКА ГРИ — дрібні шматки стану, які не належать розмітці.

   Три окремі хуки, а не один «стан HUD»: валюта, відкрите вікно й
   ознака живої заявки не мають нічого спільного, крім того, що всі
   троє знадобились одному компоненту. Складати їх в одну структуру
   означало б зробити ще один god-object, тільки в хуку.
   ============================================================ */

import { useCallback, useEffect, useState } from 'react';
import { Api } from '../lib/api';
import { loadCurrency, saveCurrency, type CurrencyCode } from '../lib/currency';

/* ---- валюта показу ----
   Косметика: сервер завжди рахує в ₽, тут лише те, якими цифрами це
   малюють. Читаємо з localStorage ПІСЛЯ монтування — інакше
   SSR-розмітка ('RUB') не збіглась би з клієнтською. */
export function useCurrency(onChange: (c: CurrencyCode) => void) {
  const [currency, setCurrency] = useState<CurrencyCode>('RUB');

  useEffect(() => { setCurrency(loadCurrency()); }, []);
  useEffect(() => { onChange(currency); }, [currency, onChange]);

  const change = useCallback((c: CurrencyCode) => {
    setCurrency(c);
    saveCurrency(c);
  }, []);

  return [currency, change] as const;
}

/* ---- яке вікно відкрите ----
   Одне поле замість п'яти прапорців. Річ не в економії рядків:
   п'ять незалежних булів описують і стани, яких не буває, — два
   вікна поверх одного, — а тут вони просто невиразні. */
export type ModalId = 'deposit' | 'withdraw' | 'payments' | 'fair' | 'buy';

export function useModal() {
  const [modal, setModal] = useState<ModalId | null>(null);
  const open = useCallback((id: ModalId) => setModal(id), []);
  const close = useCallback(() => setModal(null), []);
  return { modal, open, close };
}

/* ---- жива заявка на поповнення ----
   Вона живе 30 хвилин і не показується ніде, крім свого вікна: закрив —
   і про таймер більше ніщо не нагадує. Тому питаємо про неї на старті
   й після кожного закриття вікна, а HUD малює крапку на кнопці «+». */
export function useDepositBadge() {
  const [pending, setPending] = useState(false);

  const check = useCallback(() => {
    // тиха перевірка: не вийшло — просто не показуємо крапку
    void Api.payments().then((r) => setPending(!!r.active)).catch(() => {});
  }, []);

  useEffect(() => { check(); }, [check]);

  return { pending, check };
}
