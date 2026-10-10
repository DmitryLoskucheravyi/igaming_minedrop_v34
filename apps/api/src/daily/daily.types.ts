/* ============================================================
   ЩОДЕННА НАГОРОДА — правила й календарна арифметика.

   Окремо від сервісу, бо тут немає ні гравців, ні Nest: чисті числа й
   функції. Так їх можна перевірити тестом без стенду (test/daily).

   ДВІ РЕЧІ В ОДНІЙ НАГОРОДІ:
     DAILY_REFILL  — поповнення коінів, однакове щодня;
     STREAK_COINS  — нагорода за серію заходів поспіль. День N серії
                     дає STREAK_COINS[N-1]. Пропустив добу — серія
                     починається з першого дня. Пройшов усі 30 — цикл
                     іде на друге коло з першого дня.

   ДОБА — КАЛЕНДАРНА, у поясі DAILY_TZ, а не «24 години від минулого
   разу». Інакше людина, яка вчора забрала нагороду о 23:00, сьогодні
   чекала б до 23:00, а та, що зайшла о 9 ранку, а потім о 10 — бачила
   б зірваний стрік через годину різниці.
   ============================================================ */

export const DAILY_REFILL = 500;

/** скільки днів у циклі серії */
export const STREAK_DAYS = 30;

/* Нагорода серії: день N -> N * 1000. Перший день 1000, другий 2000,
   і так місяць — тридцятий день дає 30 000. */
export const STREAK_COINS: readonly number[] =
  Array.from({ length: STREAK_DAYS }, (_, i) => (i + 1) * 1000);

const DAY_MS = 24 * 60 * 60 * 1000;

/* Кеш форматерів: Intl.DateTimeFormat дорогий у створенні, а пояс на
   сервері один. */
const fmts = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string): Record<string, number> {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmts.set(tz, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(ms)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Календарна доба моменту ms у поясі tz: 'YYYY-MM-DD'. */
export function dayKey(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/* Скільки діб між двома ключами. Через UTC-полуночі, а не через
   різницю мілісекунд: доба з переходом на літній час триває 23 години,
   і ділення на DAY_MS там дало б дріб. */
export function daysBetween(from: string, to: string): number {
  const at = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / DAY_MS);
}

/** Коли в поясі tz почнеться наступна доба після моменту ms. */
export function nextDayAt(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const sinceMidnight = ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (ms % 1000);
  return ms - sinceMidnight + DAY_MS;
}

/* Який день серії гравець забере сьогодні.

   last — доба, за яку забирав востаннє (null — ніколи), streak — день
   серії, забраний тоді. Учора -> наступний день (після 30-го знову 1),
   давніше або ніколи -> перший. Сьогодні вже забирав -> той самий день,
   повторно його не видадуть (це перевіряє сервіс). */
export function streakDay(last: string | null, streak: number, today: string): number {
  if (!last) return 1;
  const gap = daysBetween(last, today);
  if (gap === 0) return Math.max(1, streak);
  if (gap === 1) return (streak % STREAK_DAYS) + 1;
  return 1;
}
