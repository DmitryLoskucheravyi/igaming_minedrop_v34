'use client';

/* ============================================================
   КУПІВЛЯ ПАКЕТА ФРІСПІНІВ.

   Гравець платить один раз і отримує пакет прокрутів із подвоєним
   шансом кірки. Вікно нічого не рахує: ціни, розмір пакета й множник
   приходять із сервера, покупку теж робить він — тут лише вибір ставки
   й кнопка.

   Виграш із цих прокрутів — ЗВИЧАЙНІ гроші, без замка: пакет куплено
   за власні, а відіграш вішають на подарунки. Ціна ж іде в оборот, як
   і будь-яка інша ставка.
   ============================================================ */

import { useEffect, useState } from 'react';
import { Api, type SpinsState } from '../lib/api';
import { Modal } from './Modal';
import { rub } from '../lib/format';

interface Props {
  onClose: () => void;
  /** пакет куплено — перечитати баланс */
  onBought?: () => void;
}

export function SpinsModal({ onClose, onBought }: Props) {
  const [state, setState] = useState<SpinsState | null>(null);
  const [bet, setBet] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Api.spins()
      .then((s) => {
        if (!alive) return;
        setState(s);
        /* За замовчуванням — найдешевший пакет, який гравець може собі
           дозволити; якщо не може жодного, лишаємо найдешевший, щоб
           було видно ціну входу. */
        const bets = Object.keys(s.prices).map(Number).sort((a, b) => a - b);
        setBet(bets.find((b) => s.prices[b] <= s.balance) ?? bets[0] ?? null);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  const buy = async () => {
    if (!bet || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await Api.buySpins(bet);
      setState((prev) => (prev ? { ...prev, left: r.left, bet: r.bet, balance: r.balance } : prev));
      onBought?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const price = state && bet ? state.prices[bet] ?? 0 : 0;
  const bets = state ? Object.keys(state.prices).map(Number).sort((a, b) => a - b) : [];

  return (
    <Modal title="Фриспины" onClose={onClose}>
      {error && <p className="err">{error}</p>}
      {!state && !error && <p className="hint">Загрузка…</p>}

      {state && state.left > 0 && (
        <p className="fs-left">
          У тебя <b>{state.left}</b> прокрутов по {rub(state.bet)} ₽.
          Они сыграют сами при следующем спине.
        </p>
      )}

      {state && state.left === 0 && (
        <>
          <p className="dep-sub">
            {state.pack} прокрутов с шансом кирки в <b>x{state.chanceX}</b> выше обычного.
            Выигрыш — обычные деньги: выводится без отыгрыша.
          </p>

          <span className="dep-label">Ставка прокрута</span>
          <div className="fs-bets">
            {bets.map((b) => (
              <button
                key={b}
                type="button"
                className={'fs-bet' + (b === bet ? ' on' : '')}
                disabled={state.prices[b] > state.balance}
                onClick={() => setBet(b)}
              >
                <span className="fs-bet-v">{rub(b)} ₽</span>
                <span className="fs-bet-p">{rub(state.prices[b])} ₽</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            className="btn primary wide"
            disabled={busy || !bet || price > state.balance}
            onClick={() => void buy()}
          >
            {busy ? 'Покупаю…'
              : price > state.balance ? 'Недостаточно монет'
              : `Купить ${state.pack} прокрутов · ${rub(price)} ₽`}
          </button>
        </>
      )}
    </Modal>
  );
}
