'use client';

/* ============================================================
   MODAL — спільна оболонка для вікон гри (депозит, чесність,
   історія платежів).

   Закривається трьома звичними способами: хрестик, клавіша Esc,
   клік по затемненню поза вікном. Раніше працював лише хрестик —
   на телефоні це відчувалось як пастка, бо решта інтерфейсу
   (включно з адмінкою) закривається саме тапом повз вікно.

   Закриття по фону повішено на mousedown, а не на click: інакше
   виділення тексту, розпочате ВСЕРЕДИНІ вікна (наприклад, адреса
   гаманця) і відпущене за його межами, рахувалось би як клік по
   фону й закривало вікно посеред копіювання.
   ============================================================ */

import { useEffect, type ReactNode } from 'react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modalbox">
        <div className="modalhead">
          <h2>{title}</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Закрыть">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
