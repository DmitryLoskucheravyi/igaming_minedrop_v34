'use client';

/* ============================================================
   GAMECLIENT — HUD у React, поле у canvas.

   МОБІЛЬНИЙ РЕДИЗАЙН
   Стара версія тримала баланс, ставку, стрік, повідомлення й три
   кнопки в одному горизонтальному рядку зверху — на телефоні це
   не влазило й здавалось сплюснутим. Тепер:

     - зверху лишається тільки бургер (☰) і компактний баланс;
     - усе другорядне (стрік, деталі, чесність) — у висувному
       меню за бургером, а не втиснуте в шапку;
     - знизу — окрема панель дій: степер ставки, і по центру
       ВЕЛИКА кнопка «ГРАТИ» (саме вона й запускає рулетку) —
       найважливіший елемент, тому в центрі, а не десь у рядку;
     - живий статус ("Крутимо…", помилки) — тонка плашка над
       полем, а не окрема колонка в шапці.

   React тут тримає тільки те, що виглядає як інтерфейс. Саме
   поле малюється в canvas через Presenter — 60 кадрів на секунду
   крізь реакт-стан проганяти нема сенсу. Жодне число тут не
   рахується — усе приходить із сервера через Presenter.
   ============================================================ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Presenter, type HudState } from '../game/presenter';
import { FairPanel } from './FairPanel';

const EMPTY: HudState = {
  state: 'LOADING',
  balance: 0,
  bet: 50,
  bets: [10, 25, 50, 100, 250],
  streak: 0,
  streakNeeded: 12,
  bonusPending: false,
  buyCost: 0,
  message: 'завантаження…',
  canSpin: false,
  canBuy: false,
  spinLabel: 'ГРАТИ',
  busy: false,
  resultEmpty: false,
  verified: null,
  fair: null,
  error: null,
};

export function GameClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Presenter | null>(null);
  const [hud, setHud] = useState<HudState>(EMPTY);
  const [showFair, setShowFair] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const game = new Presenter(canvas, setHud);
    gameRef.current = game;
    void game.init();

    return () => {
      game.destroy();
      gameRef.current = null;
    };
  }, []);

  const spin = useCallback(() => gameRef.current?.primary(), []);
  const buy = useCallback(() => gameRef.current?.buy(), []);
  const setBet = useCallback((b: number) => gameRef.current?.setBet(b), []);

  const idle = hud.state === 'IDLE' && !hud.busy;
  const betIdx = Math.max(0, hud.bets.indexOf(hud.bet));
  const betDown = useCallback(() => {
    if (betIdx > 0) setBet(hud.bets[betIdx - 1]);
  }, [betIdx, hud.bets, setBet]);
  const betUp = useCallback(() => {
    if (betIdx < hud.bets.length - 1) setBet(hud.bets[betIdx + 1]);
  }, [betIdx, hud.bets, setBet]);

  const openFair = useCallback(() => { setMenuOpen(false); setShowFair(true); }, []);

  // тонка плашка статусу над полем: помилка — завжди, живе повідомлення —
  // тільки поки триває раунд (у IDLE цьому місцю нема чого сказати).
  // RESULT без панелі на канвасі (нульовий виграш) — тут і тільки тут
  // повідомлення показує сам HUD, бо полю нема чого малювати.
  const showMessage = hud.state !== 'IDLE' && (hud.state !== 'RESULT' || hud.resultEmpty);
  const statusText = hud.error ?? (showMessage ? hud.message : '');

  return (
    <div className="shell">
      <header className="topbar">
        <button
          type="button"
          className="burger"
          aria-label="Меню"
          onClick={() => setMenuOpen(true)}
        >
          <span /><span /><span />
        </button>

        <div className="balance-chip">
          <span className="label">БАЛАНС</span>
          <span className="value">{hud.balance}</span>
        </div>
      </header>

      <div className="stage">
        <canvas ref={canvasRef} />

        {!!statusText && (
          <div className={'statusline' + (hud.error ? ' err' : '')}>
            {statusText}
            {hud.verified === true && <span className="verified" title="Клієнт перерахував раунд із сида і зійшовся з сервером"> ✓</span>}
            {hud.verified === false && <span className="mismatch" title="Локальний перерахунок не зійшовся з сервером — дивись консоль"> ✕</span>}
          </div>
        )}

        {hud.state === 'LOADING' && <div className="loader"><span>ЗАВАНТАЖЕННЯ…</span></div>}
        {hud.state === 'ERROR' && (
          <div className="loader">
            <span>
              API не відповідає.<br />
              Підніми сервер: <code>npm run dev:api</code>
            </span>
          </div>
        )}
      </div>

      <footer className="bottombar">
        <div className="betstepper">
          <button type="button" className="stepbtn" disabled={!idle || betIdx <= 0} onClick={betDown}>−</button>
          <div className="betvalue">{hud.bet}</div>
          <button type="button" className="stepbtn" disabled={!idle || betIdx >= hud.bets.length - 1} onClick={betUp}>+</button>
        </div>

        <button type="button" className="playbtn" disabled={!hud.canSpin} onClick={spin}>
          {hud.busy ? '…' : hud.spinLabel}
        </button>

        <button type="button" className="buybtn" disabled={!hud.canBuy} onClick={buy}>
          <span className="buybtn-label">БОНУС</span>
          <span className="buybtn-cost">-{hud.buyCost}</span>
        </button>
      </footer>

      <div
        className={'drawer-overlay' + (menuOpen ? ' open' : '')}
        onClick={() => setMenuOpen(false)}
      >
        <aside className={'drawer' + (menuOpen ? ' open' : '')} onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>МЕНЮ</h2>
            <button type="button" className="x" onClick={() => setMenuOpen(false)}>✕</button>
          </div>

          <div className="drawer-row">
            <span className="label">БАЛАНС</span>
            <span className="drawer-value">{hud.balance}</span>
          </div>

          <div className="drawer-row">
            <span className="label">СТРІК ДО БОНУСКИ</span>
            <span className="drawer-value">
              {hud.streakNeeded <= 6
                ? '●'.repeat(hud.streak) + '○'.repeat(Math.max(0, hud.streakNeeded - hud.streak))
                : `${hud.streak}/${hud.streakNeeded}`}
            </span>
          </div>

          {hud.bonusPending && <div className="drawer-note">Бонуска виграна — тисни «ГРАТИ»</div>}

          <button type="button" className="drawer-btn" onClick={openFair}>
            ЧЕСНІСТЬ РАУНДУ
          </button>
        </aside>
      </div>

      {showFair && <FairPanel fair={hud.fair} onClose={() => setShowFair(false)} />}
    </div>
  );
}
