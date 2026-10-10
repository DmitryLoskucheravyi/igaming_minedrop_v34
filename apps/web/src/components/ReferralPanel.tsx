'use client';

/* ============================================================
   РЕФЕРАЛЬНИЙ КАБІНЕТ — своє посилання, друзі, заробіток.

   Вікно тільки читає: коіни нараховує сервер у момент, коли друг
   прийшов, тож тут нема ні кнопки «забрати», ні стану, який можна
   розсинхронити. Гравець бачить готовий підсумок.
   ============================================================ */

import { Api, type ReferralState } from '../lib/api';
import { Modal } from './Modal';
import { useResource } from '../hooks/useResource';
import { useCopy } from '../hooks/useCopy';
import { whenFull } from '../lib/format';
import { Coins } from './Money';

export function ReferralPanel({ onClose }: { onClose: () => void }) {
  const { data, error, loading } = useResource<ReferralState>(() => Api.referrals());
  const { copy, copied, failed } = useCopy();

  /* Посилання може ще не зібратись (сервер не встиг спитати в телеграма
     ім'я бота) — тоді ділимося самим кодом: друг уведе його вручну. */
  const share = data?.link ?? data?.code ?? '';

  return (
    <Modal title="Пригласи друга" onClose={onClose}>
      {error && <p className="err">{error}</p>}
      {loading && !error && <p className="hint">Загрузка…</p>}

      {data && (
        <>
          <div className="ref-hero">
            <span className="ref-hero-sum">+<Coins value={data.joinCoins} /></span>
            <span className="ref-hero-what">за каждого друга, который зайдёт по твоей ссылке</span>
          </div>

          <div className="ref-total">
            <span className="label">ЗАРАБОТАНО</span>
            <span className="ref-total-sum"><Coins value={data.earned} /></span>
          </div>

          <span className="dep-label">Твоя ссылка</span>
          <button
            type="button"
            className="ref-link"
            onClick={() => void copy(share, 'link')}
            title="Скопировать"
          >
            <span className="ref-link-text">{share}</span>
            <span className="ref-link-copy">{copied === 'link' ? 'скопировано' : 'копировать'}</span>
          </button>
          {failed && <p className="dep-sub">Буфер обмена недоступен — выдели и скопируй вручную.</p>}

          <span className="dep-label">
            Друзья {data.friends.length > 0 && <b>· {data.friends.length}</b>}
          </span>

          {data.friends.length === 0
            ? <p className="hint">Пока никто не зашёл. Отправь ссылку — начисление придёт само.</p>
            : (
              <div className="ref-list">
                {data.friends.map((f) => (
                  <div key={f.telegramId} className="ref-item paid">
                    <div className="ref-item-top">
                      <span className="ref-name">{f.name}</span>
                      <span className="ref-earned">+<Coins value={f.earned} /></span>
                    </div>
                    <div className="ref-item-sub">
                      <span>{whenFull(f.at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </>
      )}
    </Modal>
  );
}
