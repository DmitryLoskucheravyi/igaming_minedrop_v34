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
import type { TierId } from '@minedrop/engine';
import { Presenter, type HudState } from '../game/presenter';
import { CURRENCIES, CURRENCY_META, FALLBACK_RATES, type CurrencyCode } from '../lib/currency';
import { useCurrency, useDepositBadge, useModal, useWheelBadge } from '../hooks/useGameShell';
import { Money } from './Money';
import { FairPanel } from './FairPanel';
import { BonusBuyModal } from './BonusBuyModal';
import { DepositModal } from './DepositModal';
import { WithdrawModal } from './WithdrawModal';
import { PaymentsPanel } from './PaymentsPanel';
import { WheelModal } from './WheelModal';
import { ReferralPanel } from './ReferralPanel';
import { SpinsModal } from './SpinsModal';
import { PixIcon } from '../ui/PixIcon';

const EMPTY: HudState = {
  state: 'LOADING',
  balance: 0,
  bet: 50,
  bets: [10, 25, 50, 100, 250, 500, 1000, 2000],
  message: 'загрузка…',
  canSpin: false,
  dryStreak: 0,
  pityAt: 7,
  scatters: 0,
  scatterNeed: 3,
  pendingBonus: null,
  rates: FALLBACK_RATES,
  buyPrices: {},
  busy: false,
  resultEmpty: false,
  verified: null,
  speed: 1,
  autoplay: false,
  muted: false,
  fair: null,
  error: null,
  profile: null,
};

/* Стани, під час яких раунд реально розігрується на полі. Саме тоді
   нижня панель кнопок їде вниз, звільняючи місце під живий лог. */
const PLAYING_STATES: HudState['state'][] = ['SPIN', 'RISE', 'RUNNING', 'DROPDONE'];

export function GameClient() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Presenter | null>(null);
  const [hud, setHud] = useState<HudState>(EMPTY);
  // обраний слайд бонуски переживає закриття вікна — див. BonusBuyModal
  const [buySlide, setBuySlide] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  // Іконку профілю кладемо файлом у public/. Поки її нема (або не
  // завантажилась) — показуємо квадрат із першою літерою імені.
  const [avatarOk, setAvatarOk] = useState(true);

  const { modal, open, close } = useModal();
  const deposit = useDepositBadge();
  const wheel = useWheelBadge();
  const [currency, changeCurrency] = useCurrency(
    useCallback((c: CurrencyCode) => gameRef.current?.setCurrency(c), []));

  /* Пункт меню завжди робить дві речі: ховає шухляду й відкриває
     вікно. Разом, щоб жоден пункт не забув першу половину. */
  const openFrom = useCallback((id: Parameters<typeof open>[0]) => {
    setMenuOpen(false);
    open(id);
  }, [open]);

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

  /* Заявку на депозит вирішили в CRM — баланс на сервері змінився, а
     гра сама туди не ходить поза раундами. Перечитуємо стан гравця. */
  const refreshPlayer = useCallback(() => { void gameRef.current?.refreshPlayer(); }, []);

  const spin = useCallback(() => gameRef.current?.primary(), []);
  /* Бонус бай: купівля запускає раунд одразу. Вікно закриває СЕБЕ САМЕ
     (Modal віддає close у children), інакше стан знімався б тут — і
     вікно зникало б ривком, повз анімацію закриття. */
  const buyBonus = useCallback((tier: TierId) => {
    gameRef.current?.buyBonus(tier);
  }, []);
  const setBet = useCallback((b: number) => gameRef.current?.setBet(b), []);
  const cycleSpeed = useCallback(() => gameRef.current?.cycleSpeed(), []);
  const toggleMute = useCallback(() => gameRef.current?.toggleMute(), []);
  const toggleAutoplay = useCallback(() => gameRef.current?.toggleAutoplay(), []);

  // Степер заблокований лише поки триває сама анімація раунду (від
  // прокруту до падіння кірки) — щойно з'являється RESULT (чи ми в
  // IDLE), знову можна міняти ставку одразу, без тапу по екрану.
  const roundInFlight = hud.state !== 'IDLE' && hud.state !== 'RESULT';

  /* Розіграш іде — нижня панель з'їжджає вниз (див. globals.css).
     Живий лог виграшу малюється на канвасі якраз у цій смузі, і кнопки
     його просто перекривали. Лишається тільки кнопка швидкості: саме
     нею є сенс користуватись під час польоту.
     LOADING/ERROR сюди не входять — там ховати нема чого. */
  const playing = PLAYING_STATES.includes(hud.state);
  // Робастніше за indexOf-по-точному-значенню: якщо hud.bet раптом не
  // збігається буквально з жодним значенням у hud.bets (напр. після
  // оновлення конфігу), indexOf дає -1, і Math.max(0,-1) тихо трактує
  // це як "найменша ставка" — степер міг здаватись «заклинилим». Тут
  // просто шукаємо найближче більше/менше число, без прив'язки до
  // точного індексу.
  const bets = hud.bets;
  /* Виграна бонуска прив'язана до ставки, на якій її виграли, і піде
     наступним прокрутом саме на ній. Тому міняти ставку зараз просто
     ні на що не впливає — і кнопки замкнені, щоб гравець не думав, що
     обирає розмір безкоштовного раунду. */
  const bonusNext = !!hud.pendingBonus;
  const canBetDown = !roundInFlight && !bonusNext && bets.some((b) => b < hud.bet);
  const canBetUp = !roundInFlight && !bonusNext && bets.some((b) => b > hud.bet);

  // Ставку можна міняти будь-коли: серія до гарантії «прив'язана» до
  // ставки, на якій набивається (у кожної ставки — своя). Перемкнувся
  // на іншу — там серія своя (найчастіше 0); повернувся назад — стара
  // серія на місці. Тож перекинути гарантовану кірку на дорогу ставку
  // неможливо, і питати підтвердження не треба.
  const betDown = useCallback(() => {
    const prev = [...bets].reverse().find((b) => b < hud.bet);
    if (prev !== undefined) setBet(prev);
  }, [bets, hud.bet, setBet]);
  const betUp = useCallback(() => {
    const next = bets.find((b) => b > hud.bet);
    if (next !== undefined) setBet(next);
  }, [bets, hud.bet, setBet]);

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

        {/* Звук. Стоїть у шапці, а не в нижній панелі дій: там усе
            пов'язане зі ставкою, і кнопка, що ставки не стосується,
            читалась би як частина керування раундом. */}
        <button
          type="button"
          className={'mutebtn' + (hud.muted ? ' off' : '')}
          onClick={toggleMute}
          aria-label={hud.muted ? 'Включить музыку' : 'Выключить музыку'}
          aria-pressed={hud.muted}
          title={hud.muted ? 'Музыка выключена' : 'Музыка включена'}
        >
          <svg className="ic-fill" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9h4l5-4v14l-5-4H4z" />
            {hud.muted
              ? <path className="ic-slash" d="M16 9l5 6M21 9l-5 6" />
              : <path className="ic-wave" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
          </svg>
        </button>

        <div className="balance-chip">
          <span className="label">БАЛАНС</span>
          <span className="value">
            <Money rub={hud.balance} currency={currency} rates={hud.rates} whole bump />
          </span>
          <button
            type="button"
            className={'deposit-btn' + (deposit.pending ? ' pending' : '')}
            aria-label={deposit.pending ? 'Пополнить (есть активная заявка)' : 'Пополнить'}
            onClick={() => open('deposit')}
          >
            +
          </button>
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

        {hud.state === 'LOADING' && <div className="loader"><span>Загрузка…</span></div>}
        {hud.state === 'ERROR' && (
          <div className="loader">
            <span>
              API не отвечает.<br />
              Подними сервер: <code>npm run dev:api</code>
            </span>
          </div>
        )}

        {/* Плаваюче керування: прозорий фон, по центру знизу. Ставка над
            круглою кнопкою «крутити», по боках — «−» / «+». */}
        <div className={'controls' + (playing ? ' playing' : '') + (hud.autoplay ? ' auto' : '')}>
          {bonusNext && (
            <div className="bonusnext">
              <span className="bonusnext-stars">★ ★ ★</span>
              <span>СЛЕДУЮЩИЙ РАУНД — БОНУСКА, БЕСПЛАТНО</span>
            </div>
          )}

          {/* Прогрес до гарантованої кірки більше не пігулка з текстом:
              його показують палички в семи сегментах кільця слота —
              за кожну пусту ставку лягає червона, а на гарантії всі
              сім стають зеленими. Два індикатори одного й того самого
              сперечалися б за увагу. */}

          {/* Бонус бай доступний і з поля, не тільки з меню: це платна
              дія, за якою тягнуться, не відкриваючи бургер. На час
              розіграшу з'їжджає вниз разом з рештою панелі. */}
          <button
            type="button"
            className="buybtn"
            onClick={() => open('buy')}
            disabled={roundInFlight}
          >
            Бонус бай
          </button>

          <div className="bet-readout">
            <Money rub={hud.bet} currency={currency} rates={hud.rates} whole bump />
          </div>

          <div className="control-row">
            <button
              type="button"
              className={'sidebtn speedbtn' + (hud.speed > 1 ? ' fast' : '')}
              onClick={cycleSpeed}
              aria-label={'Скорость ×' + hud.speed}
              title={'Скорость игры ×' + hud.speed}
            >
              {hud.speed > 1
                ? <span className={'speed-num' + (hud.speed >= 10 ? ' small' : '')}>{hud.speed}×</span>
                : (
                  <svg className="ic-stroke" viewBox="0 0 24 24" aria-hidden="true">
                    <polyline points="5 5 12 12 5 19" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                )}
            </button>

            <div className="control-core">
              <button type="button" className="stepbtn" disabled={!canBetDown} onClick={betDown} aria-label="Ставка меньше">−</button>

              <button
                type="button"
                className="playbtn"
                disabled={!hud.canSpin}
                onClick={spin}
                aria-label="Играть"
              >
                {hud.busy
                  ? <span className="playbtn-wait">…</span>
                  : (
                    <svg className="playbtn-spin" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M3.4 12a8.6 8.6 0 0 1 14.6-6.1l2.6 2.6" />
                      <polyline points="20.6 3 20.6 8.5 15.1 8.5" />
                      <path d="M20.6 12a8.6 8.6 0 0 1-14.6 6.1l-2.6-2.6" />
                      <polyline points="3.4 21 3.4 15.5 8.9 15.5" />
                    </svg>
                  )}
              </button>

              <button type="button" className="stepbtn" disabled={!canBetUp} onClick={betUp} aria-label="Ставка больше">+</button>
            </div>

            <button
              type="button"
              className={'sidebtn autobtn' + (hud.autoplay ? ' on' : '')}
              onClick={toggleAutoplay}
              aria-label={hud.autoplay ? 'Выключить автоигру' : 'Включить автоигру'}
              aria-pressed={hud.autoplay}
              title={hud.autoplay ? 'Автоигра включена' : 'Автоигра'}
            >
              {hud.autoplay
                ? <svg className="ic-fill" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
                : <svg className="ic-fill" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l12 7-12 7z" /></svg>}
            </button>
          </div>
        </div>
      </div>

      <div
        className={'drawer-overlay' + (menuOpen ? ' open' : '')}
        onClick={() => setMenuOpen(false)}
      >
        <aside className={'drawer' + (menuOpen ? ' open' : '')} onClick={(e) => e.stopPropagation()}>
          <div className="drawer-head">
            <h2>Меню</h2>
            <button type="button" className="x" onClick={() => setMenuOpen(false)}>✕</button>
          </div>

          {hud.profile && (
            <div className="drawer-profile">
              {avatarOk ? (
                <img
                  className="avatar avatar-img"
                  src="/ui/profile.png"
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
              <Money rub={hud.balance} currency={currency} rates={hud.rates} whole bump />
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

          <button type="button" className="drawer-item" onClick={() => openFrom('deposit')}>
            <PixIcon name="deposit" />
            Пополнить баланс
          </button>
          {/* Колесо стоїть одразу під поповненням і світить крапкою,
              коли прокрут доступний: подарунок, про який не нагадали,
              все одно що не подарували. */}
          <button
            type="button"
            className={'drawer-item' + (wheel.ready ? ' on' : '')}
            onClick={() => openFrom('wheel')}
          >
            <PixIcon name="wheel" />
            Колесо удачи
            {wheel.ready && <span className="dot" aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="drawer-item accent"
            onClick={() => openFrom('buy')}
          >
            <PixIcon name="buy" />
            Бонус бай
          </button>
          <button type="button" className="drawer-item" onClick={() => openFrom('spins')}>
            <PixIcon name="spins" />
            Фриспины
          </button>
          <button type="button" className="drawer-item" onClick={() => openFrom('ref')}>
            <PixIcon name="ref" />
            Пригласи друга
          </button>
          <button type="button" className="drawer-item" onClick={() => openFrom('withdraw')}>
            <PixIcon name="withdraw" />
            Вывод средств
          </button>
          <button type="button" className="drawer-item" onClick={() => openFrom('payments')}>
            <PixIcon name="history" />
            История платежей
          </button>
          <button type="button" className="drawer-item" onClick={() => openFrom('fair')}>
            <PixIcon name="fair" />
            Честность раунда
          </button>
        </aside>
      </div>

      {modal === 'buy' && (
        <BonusBuyModal
          bet={hud.bet}
          balance={hud.balance}
          buyPrices={hud.buyPrices}
          currency={currency}
          rates={hud.rates}
          onBuy={buyBonus}
          onClose={close}
          index={buySlide}
          onIndex={setBuySlide}
        />
      )}
      {modal === 'fair' && <FairPanel fair={hud.fair} onClose={close} />}
      {modal === 'deposit' && (
        <DepositModal
          onClose={() => { close(); deposit.check(); }}
          onResolved={() => { refreshPlayer(); deposit.check(); }}
        />
      )}
      {modal === 'withdraw' && (
        <WithdrawModal
          balance={hud.balance}
          currency={currency}
          rates={hud.rates}
          onClose={close}
          onBalance={refreshPlayer}
        />
      )}
      {modal === 'payments' && <PaymentsPanel onClose={close} />}
      {modal === 'ref' && <ReferralPanel onClose={close} />}
      {modal === 'spins' && <SpinsModal onClose={close} onBought={refreshPlayer} />}
      {modal === 'wheel' && (
        <WheelModal
          onClose={close}
          onWon={() => { refreshPlayer(); wheel.setReady(false); }}
        />
      )}
    </div>
  );
}
