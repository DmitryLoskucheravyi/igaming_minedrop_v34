'use client';

/* ============================================================
   ДАТА — свій календар замість <input type="date">.

   Нативний віджет малює операційна система: він світлий у темній CRM,
   виглядає інакше в кожному браузері й ніяк не піддається стилям. Тому
   поле — звичайна кнопка з підписом, а календар нижче ми малюємо самі.

   Значення лишається у форматі YYYY-MM-DD, як і в нативного інпута, —
   логіка фільтра (Filters.passes) від заміни не змінилась.
   ============================================================ */

import { useEffect, useRef, useState } from 'react';
import s from './admin.module.css';

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const parse = (v: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};

const human = (v: string): string => {
  const d = parse(v);
  return d ? d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
};

/* Понеділок — перший. getDay() віддає неділю нулем, тому зсуваємо. */
const mondayIndex = (d: Date) => (d.getDay() + 6) % 7;

export function DateField({ value, onChange, placeholder = 'не важно' }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => parse(value) ?? new Date());
  const box = useRef<HTMLDivElement>(null);

  /* Закриття по кліку повз і по Esc — те, що нативний віджет робив сам
     і що доводиться повертати руками. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = parse(value);
  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const lead = mondayIndex(first);
  const today = iso(new Date());

  const cells: (Date | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(view.getFullYear(), view.getMonth(), i + 1)),
  ];

  const shift = (months: number) =>
    setView(new Date(view.getFullYear(), view.getMonth() + months, 1));

  const pick = (d: Date) => { onChange(iso(d)); setOpen(false); };

  return (
    <div className={s.dateField} ref={box}>
      <button
        type="button"
        className={`${s.input} ${s.dateBtn} ${value ? '' : s.datePlaceholder}`}
        onClick={() => { setView(parse(value) ?? new Date()); setOpen((o) => !o); }}
      >
        {value ? human(value) : placeholder}
      </button>

      {open && (
        <div className={s.calendar}>
          <div className={s.calHead}>
            <button type="button" className={s.calNav} onClick={() => shift(-1)} aria-label="Прошлый месяц">‹</button>
            <span className={s.calTitle}>{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
            <button type="button" className={s.calNav} onClick={() => shift(1)} aria-label="Следующий месяц">›</button>
          </div>

          <div className={s.calWeek}>
            {WEEK.map((w) => <span key={w}>{w}</span>)}
          </div>

          <div className={s.calGrid}>
            {cells.map((d, i) => d === null
              ? <span key={'e' + i} />
              : (
                <button
                  key={iso(d)}
                  type="button"
                  className={
                    s.calDay
                    + (selected && iso(d) === iso(selected) ? ' ' + s.calOn : '')
                    + (iso(d) === today ? ' ' + s.calToday : '')
                  }
                  onClick={() => pick(d)}
                >
                  {d.getDate()}
                </button>
              ))}
          </div>

          <div className={s.calFoot}>
            <button type="button" className={s.calLink} onClick={() => { onChange(''); setOpen(false); }}>
              Очистить
            </button>
            <button type="button" className={s.calLink} onClick={() => pick(new Date())}>
              Сегодня
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
