/* ============================================================
   RATE LIMIT — найпростіший лічильник із фіксованим вікном.

   Без залежностей і без Redis: у процесі одна Map, ключ -> скільки
   разів звернулись у поточному вікні. Цього достатньо для двох
   випадків, де воно тут потрібне:

     - POST /fairness/verify — публічний ендпоінт, який ганяє повну
       симуляцію раунду (десятки тисяч кроків фізики). Без ліміту
       цикл із curl забиває event loop і кладе гру всім;
     - вхід в адмінку — щоб пароль не можна було перебирати.

   ВАЖЛИВО ПРО КЛЮЧ: у продовій схемі API стоїть за проксі Next,
   тому req.ip там — адреса самого проксі, одна на всіх. Тому
   ключ береться з x-forwarded-for, коли він є, а поверх усього
   ще й глобальне вікно як страховка.
   ============================================================ */

export class RateLimiter {
  private readonly hits = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** true — пропускаємо; false — ліміт вичерпано. */
  take(key: string): boolean {
    const now = Date.now();
    if (this.hits.size > 5000) this.sweep(now);

    const hit = this.hits.get(key);
    if (!hit || hit.resetAt <= now) {
      this.hits.set(key, { n: 1, resetAt: now + this.windowMs });
      return true;
    }
    hit.n++;
    return hit.n <= this.limit;
  }

  /** Скільки секунд чекати до кінця вікна (для повідомлення й Retry-After). */
  retryAfterSec(key: string): number {
    const hit = this.hits.get(key);
    if (!hit) return 0;
    return Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000));
  }

  /** Скинути лічильник — після успішного входу немає за що карати. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/** Ключ клієнта: справжня адреса з-за проксі, інакше сокет. */
export function clientKey(headers: Record<string, string | string[] | undefined>, ip?: string): string {
  const raw = headers['x-forwarded-for'];
  const fwd = Array.isArray(raw) ? raw[0] : raw;
  const first = fwd?.split(',')[0]?.trim();
  return first || ip || 'unknown';
}
