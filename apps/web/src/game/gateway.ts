/* ============================================================
   ШЛЮЗ РАУНДУ — єдине місце, де гра розмовляє з сервером.

   Презентер малює й програє анімацію; ходити по мережу — не його
   робота, і тим паче не його робота знати, як саме поводитись, коли
   вебв'ю телеграма обриває з'єднання посеред відповіді. Раніше ця
   логіка стояла посеред startRound() між кадрами анімації.

   ІДЕМПОТЕНТНІСТЬ. Запит може дійти до сервера й обірватись на
   відповіді — гравець побачить помилку, хоча ставку вже списано. Тому
   в кожної спроби є ключ, і повтор іде з ТИМ САМИМ ключем: сервер
   поверне вже зіграний раунд, а не спише вдруге. Повтор рівно один і
   тільки на мережевому збої: якщо сервер ВІДПОВІВ відмовою, повторювати
   нема чого — відповідь буде та сама.

   Назовні віддаємо або результат, або готове повідомлення для гравця:
   presenter не має розбирати типи помилок HTTP.
   ============================================================ */

import { Api, ApiError, type PlayerState } from '../lib/api';
import type { RoundResult, TierId } from '@minedrop/engine';

export type PlayOutcome =
  | { ok: true; round: RoundResult; player: PlayerState }
  | { ok: false; message: string };

/* Ключ ідемпотентності: випадковий на кожну СПРОБУ гравця, а не на
   кожен HTTP-запит. crypto.randomUUID є не скрізь (старі вебв'ю), тому
   є й запасний варіант. */
const roundKey = () =>
  globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(36).slice(2);

export class RoundGateway {
  /** Стан гравця: баланс, ставки, серія, сид. */
  async me(): Promise<PlayerState> {
    return Api.me();
  }

  /** Зіграти раунд. buy — купівля гарантованої кірки (бонус бай). */
  async play(bet: number, buy?: TierId): Promise<PlayOutcome> {
    const key = roundKey();
    try {
      const res = await Api.play(bet, key, buy);
      return { ok: true, round: res.round, player: res.player };
    } catch (e) {
      // сервер відповів і відмовив — ретраїти нема сенсу
      if (e instanceof ApiError) return { ok: false, message: e.message };

      // мережа впала: одна повторна спроба ТИМ САМИМ ключем
      try {
        const res = await Api.play(bet, key, buy);
        return { ok: true, round: res.round, player: res.player };
      } catch (e2) {
        return {
          ok: false,
          message: e2 instanceof ApiError ? e2.message : 'Сервер не ответил',
        };
      }
    }
  }
}
