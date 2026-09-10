'use client';

/* ============================================================
   USECOPY — «скопіювати й показати, що скопіювалось».

   Три стани замість одного прапорця: нічого, скопійовано (з міткою,
   ЩО саме — адреса чи коментар), не вийшло. Останній стан обов'язковий:
   буфера може не бути (http-тунель, старий вебв'ю), і мовчазний провал
   на екрані переказу означає, що людина вставить не те.
   ============================================================ */

import { useCallback, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';

export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(async (text: string, what: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (await copyText(text)) {
      setFailed(false);
      setCopied(what);
      timer.current = setTimeout(() => setCopied(null), resetMs);
    } else {
      setCopied(null);
      setFailed(true);
    }
  }, [resetMs]);

  return { copied, failed, copy };
}
