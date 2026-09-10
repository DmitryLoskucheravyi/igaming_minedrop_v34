/* ============================================================
   КОПІЮВАННЯ В БУФЕР.

   navigator.clipboard існує не завжди: його немає в незахищеному
   контексті (тунель по http під час розробки) і в частині старих
   вебв'ю. Раніше помилка просто ковталась — гравець тиснув
   «Копировать», і не відбувалось РІВНО НІЧОГО: ні адреси в буфері,
   ні пояснення. Для екрана, з якого переказують гроші, це найгірший
   варіант із можливих.

   Тому тут два шляхи й чесна відповідь: false означає «скопіюй
   пальцем», і вікно має це сказати вголос.
   ============================================================ */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* заборонено або немає доступу — пробуємо старий шлях */ }

  /* Запасний шлях: прихована textarea + execCommand. Метод застарілий,
     але це єдине, що працює там, де немає Clipboard API. */
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // за межами екрана, але не display:none — інакше нічого не виділиться
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
