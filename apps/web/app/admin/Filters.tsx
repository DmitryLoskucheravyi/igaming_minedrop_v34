'use client';

/* Спільна панель фільтрів для заявок: сума від/до, дата від/до і пошук
   по гаманцю. Однакова для депозитів і виводів — у них однакові поля,
   різниця лише в тому, чия це адреса. */

import s from './admin.module.css';
import { DateField } from './DateField';

export interface ReqFilter {
  min: string;
  max: string;
  from: string;
  to: string;
  address: string;
}

export const EMPTY_FILTER: ReqFilter = { min: '', max: '', from: '', to: '', address: '' };

export const hasFilter = (f: ReqFilter) =>
  !!(f.min || f.max || f.from || f.to || f.address.trim());

/* YYYY-MM-DD -> опівніч ЦЬОГО календарного дня в локальному часі.
   Саме через конструктор (рік, місяць, день), а не через рядок:
   New Date('YYYY-MM-DD') парситься як UTC-опівніч і в не-UTC поясі
   могла б показати вчорашній/завтрашній день. */
const parseLocalDay = (v: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};

/** Чи проходить заявка крізь фільтр. Порожнє поле нічого не обмежує. */
export function passes(f: ReqFilter, amount: number, createdAt: number, address: string): boolean {
  const min = parseFloat(f.min), max = parseFloat(f.max);
  if (Number.isFinite(min) && amount < min) return false;
  if (Number.isFinite(max) && amount > max) return false;

  /* «До» включає весь день, тому межа — опівніч НАСТУПНОГО дня.
     Рахуємо його через конструктор Date, а не додаванням 86400000 мс:
     доба не завжди рівно 24 години (перехід на літній/зимовий час),
     і фіксований мілісекундний зсув у ці два дні на рік з'їжджав би
     межу на годину. new Date(y, m, day+1) сам нормалізує календарну
     дату — так само, як DateField.shift() гортає місяці. */
  if (f.from) {
    const d = parseLocalDay(f.from);
    if (d && createdAt < d.getTime()) return false;
  }
  if (f.to) {
    const d = parseLocalDay(f.to);
    if (d) {
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      if (createdAt >= next.getTime()) return false;
    }
  }

  const q = f.address.trim().toLowerCase();
  if (q && !address.toLowerCase().includes(q)) return false;
  return true;
}

/** «От» пізніше за «до» — фільтр мовчки не пропустить нічого. Про це
    варто сказати прямо, а не лишати адміна гадати, чому список порожній. */
export const invertedRange = (f: ReqFilter): boolean =>
  !!(f.from && f.to && f.from > f.to);

interface Props {
  value: ReqFilter;
  onChange: (f: ReqFilter) => void;
  shown: number;
  total: number;
  addressLabel: string;
}

export function Filters({ value, onChange, shown, total, addressLabel }: Props) {
  const set = (patch: Partial<ReqFilter>) => onChange({ ...value, ...patch });

  return (
    <div className={s.filters}>
      <label className={s.filterField}>
        <span>Сумма ₽ от</span>
        <input className={s.input} type="number" inputMode="numeric"
          value={value.min} onChange={(e) => set({ min: e.target.value })} />
      </label>
      <label className={s.filterField}>
        <span>до</span>
        <input className={s.input} type="number" inputMode="numeric"
          value={value.max} onChange={(e) => set({ max: e.target.value })} />
      </label>
      <div className={s.filterField}>
        <span>Дата с</span>
        <DateField value={value.from} onChange={(from) => set({ from })} />
      </div>
      <div className={s.filterField}>
        <span>по</span>
        <DateField value={value.to} onChange={(to) => set({ to })} />
      </div>
      <label className={`${s.filterField} ${s.filterWide}`}>
        <span>{addressLabel}</span>
        <input className={s.input} placeholder="часть адреса"
          value={value.address} onChange={(e) => set({ address: e.target.value })} />
      </label>

      {invertedRange(value) && (
        <div className={s.filterWarn}>«От» позже «до» — список будет пустым. Поменяй даты местами.</div>
      )}

      <div className={s.filterFoot}>
        <span className={s.dim}>показано {shown} из {total}</span>
        {hasFilter(value) && (
          <button type="button" className={s.btnSm} onClick={() => onChange(EMPTY_FILTER)}>
            Сбросить
          </button>
        )}
      </div>
    </div>
  );
}
