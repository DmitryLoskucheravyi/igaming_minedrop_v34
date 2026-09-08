'use client';

/* ============================================================
   ДЕПОЗИТЫ — как мы принимаем деньги, по способам оплаты.

   Не путать с «Заявками»: там то, что уже пришло и ждёт решения,
   здесь — настройка самого приёма. Подвкладка = способ оплаты, и
   общего у них почти ничего: у крипты адреса и наблюдатель за сетью,
   у звёзд — счёт в боте и свой курс.
   ============================================================ */

import { useState } from 'react';
import s from './admin.module.css';
import { CryptoIntake } from './CryptoIntake';
import { StarsIntake } from './StarsIntake';

type Way = 'crypto' | 'stars';

export function DepositsTab() {
  const [way, setWay] = useState<Way>('crypto');
  const sub = (id: Way) => `${s.subTab} ${way === id ? s.on : ''}`;

  return (
    <>
      <div className={s.head}>
        <h1>Депозиты</h1>
      </div>

      <div className={s.subTabs}>
        <button type="button" className={sub('crypto')} onClick={() => setWay('crypto')}>
          Крипто
        </button>
        <button type="button" className={sub('stars')} onClick={() => setWay('stars')}>
          TG Stars
        </button>
      </div>

      {way === 'crypto' ? <CryptoIntake /> : <StarsIntake />}
    </>
  );
}
