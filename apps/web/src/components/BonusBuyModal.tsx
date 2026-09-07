'use client';

/* ============================================================
   БОНУС БАЙ — купівля гарантованої кірки.

   Слайдер: один слайд = одна кірка. Гортається пальцем, стрілками
   з боків і крапками знизу. Кожен слайд показує, за що саме платиш:
   картинку, характеристики та ціну в поточній ставці.

   ЧОМУ ЦІНА В КОЖНОЇ КІРКИ СВОЯ
   Дерев'яна кірка й алмазна заробляють зовсім різне (заміряно
   sim/buy.ts: x1.34 проти x10.14 середньої виплати). Плаский цінник
   для всіх зробив би одну покупку грабунком, а іншу — безкоштовними
   грошима. Тому множник свій на кожну, і приходить він із СЕРВЕРА:
   тут його лише показують, списує сервер за власним конфігом.
   ============================================================ */

import { useCallback, useEffect, useRef } from 'react';
import { TIERS, type TierId } from '@minedrop/engine';
import { CURRENCY_META, fmtWhole, type CurrencyCode, type Rates } from '../lib/currency';
import { Modal } from './Modal';

interface Props {
  bet: number;
  balance: number;
  /** множник ціни на кожну кірку: ціна = ставка * множник */
  buyPrices: Record<string, number>;
  currency: CurrencyCode;
  rates: Rates;
  onBuy: (tier: TierId) => void;
  onClose: () => void;
  /* Обраний слайд живе ЗЗОВНІ, у GameClient: вікно розмонтовується при
     закритті, і власний стан скидався б на першу кірку. Гравець, який
     обирає між золотою та алмазною, щоразу починав би з дерев'яної. */
  index: number;
  onIndex: (n: number) => void;
}

/* Мінімальний свайп, щоб гортання не спрацьовувало від тремтіння
   пальця під час звичайного тапу по кнопці. */
const SWIPE_MIN_PX = 40;

export function BonusBuyModal({
  bet, balance, buyPrices, currency, rates, onBuy, onClose, index, onIndex,
}: Props) {
  const touch = useRef<{ x: number; y: number } | null>(null);

  const last = TIERS.length - 1;
  const i = Math.max(0, Math.min(last, index));
  const go = useCallback((n: number) => onIndex(Math.max(0, Math.min(last, n))), [last, onIndex]);

  // стрілки клавіатури — щоб слайдер працював і з десктопа
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [i, go]);

  const tier = TIERS[i];
  const price = Math.round(bet * (buyPrices[tier.id] ?? 0));
  const enough = balance >= price;
  const meta = CURRENCY_META[currency];

  const money = (rub: number) => (
    <span className="money">
      {fmtWhole(rub, currency, rates)}
      <img className={'cur-ico' + (meta.mono ? ' mono' : '')} src={meta.icon} alt="" />
    </span>
  );

  return (
    <Modal title="БОНУС БАЙ" onClose={onClose}>
      <p className="hint buy-lead">
        Покупка даёт выбранную кирку <b>гарантированно</b> — рулетка не крутится.
        В бонусной шахте чаще попадаются блоки-множители и столы зачарования.
      </p>

      <div
        className="buy-slider"
        onTouchStart={(e) => {
          const t = e.touches[0];
          touch.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(e) => {
          const start = touch.current;
          touch.current = null;
          if (!start) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - start.x;
          // вертикальний рух — це скрол вікна, а не гортання слайдера
          if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(t.clientY - start.y)) return;
          go(dx < 0 ? i + 1 : i - 1);
        }}
      >
        <button
          type="button"
          className="buy-arrow left"
          onClick={() => go(i - 1)}
          disabled={i === 0}
          aria-label="Предыдущая кирка"
        >
          ‹
        </button>

        <div className="buy-slide">
          <img className="buy-pick" src={tier.skin} alt="" />
          <div className="buy-name" style={{ color: tier.color }}>{tier.name.toUpperCase()}</div>
          <div className="buy-stats">
            <span><b>{tier.hp}</b> прочность</span>
            <span><b>{tier.dmg}</b> урон</span>
          </div>
          <div className="buy-coef">коэффициент цены &times;{buyPrices[tier.id] ?? '—'}</div>
        </div>

        <button
          type="button"
          className="buy-arrow right"
          onClick={() => go(i + 1)}
          disabled={i === last}
          aria-label="Следующая кирка"
        >
          ›
        </button>
      </div>

      <div className="buy-dots">
        {TIERS.map((t, n) => (
          <button
            key={t.id}
            type="button"
            className={'buy-dot' + (n === i ? ' on' : '')}
            onClick={() => go(n)}
            aria-label={t.name}
            aria-current={n === i}
          />
        ))}
      </div>

      <button
        type="button"
        className="btn wide buy-go"
        disabled={!enough || price <= 0}
        onClick={() => onBuy(tier.id as TierId)}
      >
        {enough ? <>КУПИТЬ ЗА {money(price)}</> : <>НЕ ХВАТАЕТ {money(price - balance)}</>}
      </button>

      <p className="hint buy-note">
        Ставка сейчас {money(bet)} — цена считается от неё. Меняешь ставку — меняется и цена.
      </p>
    </Modal>
  );
}
