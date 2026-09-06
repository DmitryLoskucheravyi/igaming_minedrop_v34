'use client';

/* ============================================================
   GAME GATE — гра відкривається ТІЛЬКИ з телеграма.

   Поза телеграмом (звичайний браузер, хтось знайшов адресу
   тунеля) показуємо заглушку, а не гру. Окремого «сайту з грою»
   немає — тільки мініапс + CRM на /admin.

   telegram-web-app.js підключений у layout.tsx з
   strategy="beforeInteractive", тож на момент useEffect
   window.Telegram.WebApp вже готовий, а initData непорожній
   лише коли реально запустили з телеграма.
   ============================================================ */

import { useEffect, useState } from 'react';
import { GameClient } from './GameClient';
import { inTelegram } from '../lib/telegram';

export function GameGate() {
  const [inside, setInside] = useState<boolean | null>(null);

  useEffect(() => { setInside(inTelegram()); }, []);

  if (inside === null) return null;       // перший кадр — ще не знаємо
  if (inside) return <GameClient />;

  return (
    <div className="tg-only">
      <div className="tg-only-box">
        <div className="tg-only-mark">⛏</div>
        <h1>MINEDROP</h1>
        <p>Игра открывается только в Telegram.</p>
        <p className="tg-only-hint">Найди бота и нажми «Играть».</p>
      </div>
    </div>
  );
}
