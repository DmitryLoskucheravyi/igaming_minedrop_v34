import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

/* ============================================================
   RATES — курс для ВІДОБРАЖЕННЯ балансу в інших валютах.

   Уся математика гри й баланс живуть у «рублях» (базова одиниця).
   Клієнт може показати ті самі числа в USDT або в зірках телеграма —
   це суто косметика, на гроші не впливає.

   USDT/RUB тягнемо раз на добу з публічного API (без ключа). Курс
   зірки телеграма офіційного API не має — тримаємо константою
   (≈2.8 ₽ за зірку, діапазон 2.6–3.0). Якщо запит впав — лишається
   попереднє значення, а до першого успіху — розумний fallback.
   ============================================================ */

const DAY_MS = 24 * 60 * 60 * 1000;

/* Fallback, поки перший запит не пройшов (або якщо API недоступне). */
const FALLBACK_RUB_PER_USDT = 100;
/* Курс зірки телеграма — константа (офіційного API немає). */
const RUB_PER_STAR = 2.8;

export interface RatesSnapshot {
  /** скільки рублів коштує 1 USDT */
  rubPerUsdt: number;
  /** скільки рублів коштує 1 зірка телеграма */
  rubPerStar: number;
  /** коли востаннє вдалося оновити (мс epoch); 0 — ще жодного разу */
  updatedAt: number;
}

@Injectable()
export class RatesService implements OnModuleInit {
  private readonly log = new Logger(RatesService.name);

  private rubPerUsdt = FALLBACK_RUB_PER_USDT;
  private updatedAt = 0;
  private refreshing: Promise<void> | null = null;

  async onModuleInit(): Promise<void> {
    /* Не блокуємо старт застосунку мережею: пробуємо оновити у фоні. */
    void this.refresh();
  }

  /** Поточний зріз. Побіжно тригерить фонове оновлення, якщо курс застарів. */
  snapshot(): RatesSnapshot {
    if (Date.now() - this.updatedAt > DAY_MS) void this.refresh();
    return {
      rubPerUsdt: this.rubPerUsdt,
      rubPerStar: RUB_PER_STAR,
      updatedAt: this.updatedAt,
    };
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8000);
      let value: number | null;
      try {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=rub',
          { signal: ac.signal, headers: { accept: 'application/json' } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { tether?: { rub?: number } };
        value = body.tether?.rub ?? null;
      } finally {
        clearTimeout(timer);
      }

      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error('відповідь без коректного tether.rub');
      }
      /* Захист від сміттєвих значень: рубль за долар історично 30–300. */
      if (value < 20 || value > 500) throw new Error(`підозрілий курс ${value}`);

      this.rubPerUsdt = value;
      this.updatedAt = Date.now();
      this.log.log(`курс USDT/RUB оновлено: ${value.toFixed(2)} ₽`);
    } catch (e) {
      this.log.warn(
        `курс USDT/RUB не оновлено (${(e as Error).message}). ` +
        `Лишається ${this.rubPerUsdt.toFixed(2)} ₽` +
        (this.updatedAt ? '' : ' (fallback, ще жодного успішного запиту)'),
      );
    }
  }
}
