/* ============================================================
   TELEGRAM — обгортка над Telegram.WebApp.

   Скрипт telegram-web-app.js підключений у layout.tsx. Він сам
   виставляє CSS-змінні висоти (--tg-viewport-stable-height) і
   безпечних зон, тому верстка спирається на них, а не на 100vh:
   у телеграмі шторка їздить, і 100vh дає обрізаний низ.

   Гра має відкриватись і у звичайному браузері — інакше її не
   налагодити. Тому все тут із перевірками: немає телеграма —
   працюємо як звичайна сторінка, а API вмикає dev-авторизацію.
   ============================================================ */

interface TgWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id: number; first_name?: string; username?: string } };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  isExpanded: boolean;
  viewportStableHeight: number;

  ready(): void;
  expand(): void;
  close(): void;
  disableVerticalSwipes?(): void;
  enableClosingConfirmation?(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  onEvent(event: string, cb: () => void): void;
  offEvent(event: string, cb: () => void): void;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export const tg = (): TgWebApp | null =>
  (typeof window !== 'undefined' && window.Telegram?.WebApp) || null;

export const inTelegram = (): boolean => {
  const w = tg();
  // initData порожній, якщо сторінку відкрили не з телеграма
  return !!w && typeof w.initData === 'string' && w.initData.length > 0;
};

/** Підписаний рядок для заголовка Authorization: tma <...> */
export const initData = (): string | null => {
  const w = tg();
  return w && w.initData ? w.initData : null;
};

/** Стабільний id для dev-режиму в браузері: щоб у різних вкладках
    був різний гравець, але той самий після перезавантаження. */
export function devUserId(): number {
  if (typeof window === 'undefined') return 1;
  const KEY = 'minedrop.devUser';
  const found = window.localStorage.getItem(KEY);
  if (found) return Number(found);
  const id = 100000 + Math.floor(Math.random() * 800000);
  window.localStorage.setItem(KEY, String(id));
  return id;
}

/** Версія телеграма не нижча за потрібну (для нових методів) */
function atLeast(version: string, need: string): boolean {
  const a = version.split('.').map(Number);
  const b = need.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Одноразова підготовка мініапса. Безпечно кликати поза телеграмом. */
export function setupMiniApp(): void {
  const w = tg();
  if (!w) return;

  w.ready();
  w.expand();

  /* Без цього вертикальний свайп по канвасу згортає мініапс —
     грати неможливо. Метод із Bot API 7.7, тому з перевіркою. */
  if (atLeast(w.version, '7.7')) w.disableVerticalSwipes?.();

  // гра темна — хай шапка і фон збігаються, інакше видно смуги
  w.setHeaderColor?.('#2c323b');
  w.setBackgroundColor?.('#0a0c10');
}

export function haptic(kind: 'hit' | 'win' | 'lose'): void {
  const h = tg()?.HapticFeedback;
  if (!h) return;
  if (kind === 'hit') h.impactOccurred('light');
  else h.notificationOccurred(kind === 'win' ? 'success' : 'error');
}
