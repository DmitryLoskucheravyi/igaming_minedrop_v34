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

/** Чи проходить заявка крізь фільтр. Порожнє поле нічого не обмежує. */
export function passes(f: ReqFilter, amount: number, createdAt: number, address: string): boolean {
  const min = parseFloat(f.min), max = parseFloat(f.max);
  if (Number.isFinite(min) && amount < min) return false;
  if (Number.isFinite(max) && amount > max) return false;

  /* Дата з <input type="date"> приходить як YYYY-MM-DD у локальному
     часі. «До» включає весь день, тому додаємо добу. */
  if (f.from && createdAt < new Date(f.from + 'T00:00:00').getTime()) return false;
  if (f.to && createdAt >= new Date(f.to + 'T00:00:00').getTime() + 86400000) return false;

  const q = f.address.trim().toLowerCase();
  if (q && !address.toLowerCase().includes(q)) return false;
  return true;
}

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
