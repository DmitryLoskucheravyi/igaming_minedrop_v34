'use client';

/* ============================================================
   USEWITHDRAW — логіка виведення коштів.

   Дзеркало useDeposit, але з одним принциповим розворотом: гроші
   списуються з балансу В МОМЕНТ ЗАЯВКИ, а не коли адмін її погодить.
   Інакше можна замовити виплату й далі грати тими самими грошима.
   Через це кожна дія тут повідомляє баланс назовні (onBalance): HUD не
   має показувати стару цифру ані секунди.

   Формат адреси перевіряємо ТИМ САМИМ виразом, що й сервер. Клієнт
   раніше вимагав просто «довше за 30 символів», і адреса на 31 давала
   активну кнопку та помилку з сервера у відповідь.
   ============================================================ */

import { useCallback, useState } from 'react';
import { Api, ApiError, type Withdraw, type WithdrawInfo } from '../lib/api';
import { useResource } from './useResource';

/* T + 33 символи base58 — рівно те, що перевіряє withdraw.service. */
const TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export interface WithdrawState {
  info: WithdrawInfo | null;
  error: string | null;
  busy: boolean;
  active: Withdraw | null;

  amount: number;
  setAmount: (n: number) => void;
  address: string;
  setAddress: (s: string) => void;

  min: number;
  /** замкнений бонус: прогрес, термін і стеля ставки */
  bonus: { locked: number; done: number; need: number; until: number; maxBet: number };
  /** скільки з балансу можна подати на вивід */
  available: number;
  max: number;
  tooSmall: boolean;
  /** сума більша за баланс — грошей просто немає */
  tooBig: boolean;
  /** сума більша за стелю виведення */
  overMax: boolean;
  /** адреса непорожня й НЕ схожа на TRC20 */
  badAddress: boolean;
  canSubmit: boolean;

  create: () => Promise<void>;
  cancel: () => Promise<boolean>;
}

export function useWithdraw(balance: number, onBalance: () => void): WithdrawState {
  const res = useResource<WithdrawInfo>(() => Api.withdrawals());
  const { data: info, error, reload, setData, setError } = res;

  const [amount, setAmount] = useState(0);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);

  const min = info?.minRub ?? 500;
  const max = info?.maxRub ?? Infinity;
  const active = info?.active ?? null;
  /* Розклад балансу: що можна виводити й що лежить замкненим бонусом.
     Поки сервер не відповів, вважаємо весь баланс доступним — інакше
     на мить показали б «0 до виводу» на порожньому місці. */
  const bonus = info?.bonus ?? { locked: 0, done: 0, need: 0, until: 0, maxBet: 0 };
  const available = info?.available ?? balance;

  const trimmed = address.trim();
  const tooSmall = amount < min;
  const tooBig = amount > available;
  const overMax = amount > max;
  const validAddress = TRC20_RE.test(trimmed);
  const badAddress = trimmed.length > 0 && !validAddress;
  const canSubmit = !busy && !tooSmall && !tooBig && !overMax && validAddress;

  const create = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await Api.createWithdraw(amount, address.trim());
      setData((prev) => prev
        ? { ...prev, active: r.withdraw, history: [r.withdraw, ...prev.history] }
        : prev);
      setAmount(0);
      onBalance();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось создать заявку');
    } finally {
      setBusy(false);
    }
  }, [amount, address, setData, setError, onBalance]);

  /** true — заявку знято; підтвердження питає вікно, не хук. */
  const cancel = useCallback(async () => {
    if (!active) return false;
    setBusy(true); setError(null);
    try {
      await Api.cancelWithdraw(active.id);
      await reload();
      onBalance();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось отменить');
      return false;
    } finally {
      setBusy(false);
    }
  }, [active, reload, setError, onBalance]);

  return {
    info, error, busy, active,
    amount, setAmount, address, setAddress,
    min, max, tooSmall, tooBig, overMax, badAddress, canSubmit, bonus, available,
    create, cancel,
  };
}
