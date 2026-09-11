'use client';

/* ============================================================
   БОНУС БАЙ — купівля гарантованої кірки.

   Слайдер: один слайд = одна кірка. Гортається пальцем, стрілками
   з боків і крапками знизу.

   Слайд — це НАМАЛЬОВАНА КАРТКА (public/cards) на всю ширину вікна, з
   порожніми панелями, у які компонент вписує назву, міцність і урон.
   Нижня панель — не напис, а САМА КНОПКА покупки: окрема кнопка під
   карткою дублювала б намальоване й забирала в картки висоту.
   Числа не вшиті в картинку навмисно — ціна залежить від поточної
   ставки, а міцність із уроном від балансу тірів, і кожна їх правка
   означала б перемальовування всіх чотирьох файлів. Координати панелей
   заміряно з самих картинок — див. lib/buy-cards.

   ЧОМУ ЦІНА В КОЖНОЇ КІРКИ СВОЯ
   Дерев'яна кірка й алмазна заробляють зовсім різне (заміряно
   sim/buy.ts: x1.34 проти x10.14 середньої виплати). Плаский цінник
   для всіх зробив би одну покупку грабунком, а іншу — безкоштовними
   грошима. Тому множник свій на кожну, і приходить він із СЕРВЕРА:
   тут його лише показують, списує сервер за власним конфігом.
   ============================================================ */

import { useCallback, useEffect, useRef } from 'react';
import { TIERS, type TierId } from '@minedrop/engine';
import type { CurrencyCode, Rates } from '../lib/currency';
import { Modal } from './Modal';
import { Money } from './Money';
import { BUY_CARDS, plateStyle } from '../lib/buy-cards';

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

/* Стрілка — СХОДИНКОВИЙ трикутник, а не символ ‹ і не гладкий шеврон:
   уся гра намальована пікселями, і плавна дуга поруч із блоковою
   кіркою читалась би як чужа деталь. Малюємо квадратами по 4 одиниці
   сітки, вимикаємо згладжування (shape-rendering у css) — виходить той
   самий «різаний» край, що й у спрайтів. */
function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 32" aria-hidden="true" className={'chev ' + dir}>
      <path d="M20 4h-4v4h-4v4H8v8h4v4h4v4h4z" />
    </svg>
  );
}

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
  const card = BUY_CARDS[tier.id];
  const price = Math.round(bet * (buyPrices[tier.id] ?? 0));
  const enough = balance >= price;
  const money = (rub: number) => <Money rub={rub} currency={currency} rates={rates} whole />;

  return (
    <Modal title="Бонус бай" onClose={onClose} bare>
      {(close) => (
        <>
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
              className="buy-arrow"
              onClick={() => go(i - 1)}
              disabled={i === 0}
              aria-label="Предыдущая кирка"
            >
              <Chevron dir="left" />
            </button>

            {/* Картка — намальована картинка, поверх якої лягають рівно
                чотири написи. Кожен сидить у СВОЇЙ намальованій панелі:
                координати заміряно з файлів (lib/buy-cards). */}
            <div className="buy-slide">
              <img className="buy-card" src={card.src} alt="" draggable={false} />

              <div className="buy-plate buy-title" style={plateStyle(card.geom.title)}>
                <span style={{ color: tier.color }}>{tier.name.toUpperCase()}</span>
              </div>

              <div className="buy-plate buy-stat" style={plateStyle(card.geom.left)}>
                <b>{tier.hp}</b>
                <span>прочность</span>
              </div>
              <div className="buy-plate buy-stat" style={plateStyle(card.geom.right)}>
                <b>{tier.dmg}</b>
                <span>урон</span>
              </div>

              {/* Нижня панель картки — САМА КНОПКА. Окрема кнопка під
                  карткою дублювала б те, що вже намальовано, і забирала
                  висоту в самої картки. */}
              <button
                type="button"
                className={'buy-plate buy-buy' + (enough ? '' : ' off')}
                style={plateStyle(card.geom.price)}
                disabled={!enough || price <= 0}
                onClick={() => { onBuy(tier.id as TierId); close(); }}
              >
                {enough ? <>Купить · {money(price)}</> : <>Не хватает {money(price - balance)}</>}
              </button>
            </div>

            <button
              type="button"
              className="buy-arrow"
              onClick={() => go(i + 1)}
              disabled={i === last}
              aria-label="Следующая кирка"
            >
              <Chevron dir="right" />
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
        </>
      )}
    </Modal>
  );
}
