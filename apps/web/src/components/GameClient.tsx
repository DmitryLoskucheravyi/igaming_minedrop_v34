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
import {
  CURRENCIES, CURRENCY_META, FALLBACK_RATES, fmtAmount, fmtWhole,
  loadCurrency, saveCurrency, type CurrencyCode, type Rates,
} from '../lib/currency';
import { FairPanel } from './FairPanel';

const EMPTY: HudState = {
  state: 'LOADING',
  balance: 0,
  bet: 50,
  bets: [10, 25, 50, 100, 250, 500, 1000, 2000],
  message: 'загрузка…',
  canSpin: false,
  dryStreak: 0,
  pityAt: 7,
  rates: FALLBACK_RATES,
  busy: false,
  resultEmpty: false,
  verified: null,
  fair: null,
  error: null,
  profile: null,
};

/* Сума + іконка валюти. whole — велика сума (баланс, ставка): у рублях
   ціле; дрібна (напр. частина виграшу) — з дробом. */
function Money({ rub, currency, rates, whole }: {
  rub: number; currency: CurrencyCode; rates: Rates; whole?: boolean;
}) {
  const meta = CURRENCY_META[currency];
  const s = whole ? fmtWhole(rub, currency, rates) : fmtAmount(rub, currency, rates);
  return (
    <span className="money">
      {s}
      <img className={'cur-ico' + (meta.mono ? ' mono' : '')} src={meta.icon} alt="" />
    </span>
  );
}

export function GameClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Presenter | null>(null);
  const [hud, setHud] = useState<HudState>(EMPTY);
  const [showFair, setShowFair] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Іконку профілю кладемо файлом у public/. Поки її нема (або не
  // завантажилась) — показуємо квадрат із першою літерою імені.
  const [avatarOk, setAvatarOk] = useState(true);
  // Валюта відображення (косметика). Читаємо з localStorage ПІСЛЯ
  // монтування — інакше SSR-розмітка ('RUB') не збіглась би з клієнтом.
  const [currency, setCurrencyState] = useState<CurrencyCode>('RUB');

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

  useEffect(() => { setCurrencyState(loadCurrency()); }, []);
  useEffect(() => { gameRef.current?.setCurrency(currency); }, [currency]);

  const changeCurrency = useCallback((c: CurrencyCode) => {
    setCurrencyState(c);
    saveCurrency(c);
  }, []);

  const spin = useCallback(() => gameRef.current?.primary(), []);
  const setBet = useCallback((b: number) => gameRef.current?.setBet(b), []);

  // Степер заблокований лише поки триває сама анімація раунду (від
  // прокруту до падіння кірки) — щойно з'являється RESULT (чи ми в
  // IDLE), знову можна міняти ставку одразу, без тапу по екрану.
  const roundInFlight = hud.state !== 'IDLE' && hud.state !== 'RESULT';
  // Робастніше за indexOf-по-точному-значенню: якщо hud.bet раптом не
  // збігається буквально з жодним значенням у hud.bets (напр. після
  // оновлення конфігу), indexOf дає -1, і Math.max(0,-1) тихо трактує
  // це як "найменша ставка" — степер міг здаватись «заклинилим». Тут
  // просто шукаємо найближче більше/менше число, без прив'язки до
  // точного індексу.
  const bets = hud.bets;
  const canBetDown = !roundInFlight && bets.some((b) => b < hud.bet);
  const canBetUp = !roundInFlight && bets.some((b) => b > hud.bet);
  const betDown = useCallback(() => {
    const prev = [...bets].reverse().find((b) => b < hud.bet);
    if (prev !== undefined) setBet(prev);
  }, [bets, hud.bet, setBet]);
  const betUp = useCallback(() => {
    const next = bets.find((b) => b > hud.bet);
    if (next !== undefined) setBet(next);
  }, [bets, hud.bet, setBet]);

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
          <span className="value">
            <Money rub={hud.balance} currency={currency} rates={hud.rates} whole />
          </span>
        </div>
      </header>

      <div className="stage">
        <canvas ref={canvasRef} />

        {!!statusText && (
          <div className={'statusline' + (hud.error ? ' err' : '')}>
            {statusText}
            {hud.verified === true && <span className="verified" title="Клиент пересчитал раунд из сида и сошёлся с сервером"> ✓</span>}
            {hud.verified === false && <span className="mismatch" title="Локальный пересчёт не сошёлся с сервером — смотри консоль"> ✕</span>}
          </div>
        )}

        {hud.state === 'LOADING' && <div className="loader"><span>ЗАГРУЗКА…</span></div>}
        {hud.state === 'ERROR' && (
          <div className="loader">
            <span>
              API не отвечает.<br />
              Подними сервер: <code>npm run dev:api</code>
            </span>
          </div>
        )}
      </div>

      {hud.dryStreak > 0 && (
        <div className={'pity' + (hud.dryStreak >= hud.pityAt ? ' ready' : '')}>
          {hud.dryStreak >= hud.pityAt ? (
            <span>СЛЕДУЮЩАЯ — КИРКА</span>
          ) : (
            <>
              <span className="pity-pips" aria-hidden="true">
                {'●'.repeat(hud.dryStreak) + '○'.repeat(Math.max(0, hud.pityAt - hud.dryStreak))}
              </span>
              <span>{hud.dryStreak}/{hud.pityAt} до гарантии</span>
            </>
          )}
        </div>
      )}

      <footer className="bottombar">
        <div className="betstepper">
          <button type="button" className="stepbtn" disabled={!canBetDown} onClick={betDown}>−</button>
          <div className="betvalue">
            <Money rub={hud.bet} currency={currency} rates={hud.rates} whole />
          </div>
          <button type="button" className="stepbtn" disabled={!canBetUp} onClick={betUp}>+</button>
        </div>

        <button
          type="button"
          className="playbtn"
          disabled={!hud.canSpin}
          onClick={spin}
          aria-label="Играть"
        >
          {hud.busy
            ? <span className="playbtn-wait">…</span>
            : <span className="playbtn-tri" aria-hidden="true" />}
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

          {hud.profile && (
            <div className="drawer-profile">
              {avatarOk ? (
                <img
                  className="avatar avatar-img"
                  src="/profile.png"
                  alt=""
                  onError={() => setAvatarOk(false)}
                />
              ) : (
                <div className="avatar avatar-fallback" aria-hidden="true">
                  {hud.profile.name.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="drawer-profile-id">
                <span className="pname">{hud.profile.name}</span>
                <span className="phandle">{hud.profile.handle}</span>
              </div>
            </div>
          )}

          <div className="drawer-row">
            <span className="label">БАЛАНС</span>
            <span className="drawer-value">
              <Money rub={hud.balance} currency={currency} rates={hud.rates} whole />
            </span>
          </div>

          <div className="drawer-row">
            <span className="label">ВАЛЮТА</span>
            <div className="cur-switch">
              {CURRENCIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={'cur-opt' + (c === currency ? ' on' : '')}
                  aria-pressed={c === currency}
                  title={CURRENCY_META[c].label}
                  onClick={() => changeCurrency(c)}
                >
                  <img
                    className={'cur-ico' + (CURRENCY_META[c].mono ? ' mono' : '')}
                    src={CURRENCY_META[c].icon}
                    alt={CURRENCY_META[c].label}
                  />
                </button>
              ))}
            </div>
          </div>

          <button type="button" className="drawer-btn" onClick={openFair}>
            ЧЕСТНОСТЬ РАУНДА
          </button>
        </aside>
      </div>

      {showFair && <FairPanel fair={hud.fair} onClose={() => setShowFair(false)} />}
    </div>
  );
}
