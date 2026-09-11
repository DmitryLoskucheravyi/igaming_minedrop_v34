'use client';

/* ============================================================
   РЕФЕРАЛЬНИЙ КАБІНЕТ — своє посилання, друзі, заробіток.

   Вікно тільки читає: усі нарахування робить сервер у момент події
   (друг прийшов / друг поповнив), тож тут нема ні кнопки «забрати», ні
   стану, який можна розсинхронити. Гравець бачить готовий підсумок.

   Друг, який ще не поповнив, показується окремо й приглушено — видно,
   що з нього ще буде добір, і скільки саме.
   ============================================================ */

import { Api, type ReferralState } from '../lib/api';
import { Modal } from './Modal';
import { useResource } from '../hooks/useResource';
import { useCopy } from '../hooks/useCopy';
import { rub, whenFull } from '../lib/format';

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
          <div className="ref-rules">
            <div className="ref-rule">
              <span className="ref-rule-sum">+{rub(data.joinRub)} ₽</span>
              <span className="ref-rule-what">друг зашёл по ссылке</span>
            </div>
            <div className="ref-rule">
              <span className="ref-rule-sum">+{rub(data.depositRub)} ₽</span>
              <span className="ref-rule-what">и пополнил от {rub(data.depositMin)} ₽</span>
            </div>
          </div>

          <div className="ref-total">
            <span className="label">ЗАРАБОТАНО</span>
            <span className="ref-total-sum">{rub(data.earned)} ₽</span>
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
                  <div
                    key={f.telegramId}
                    className={'ref-item' + (f.depositedAt ? ' paid' : '')}
                  >
                    <div className="ref-item-top">
                      <span className="ref-name">{f.name}</span>
                      <span className="ref-earned">+{rub(f.earned)} ₽</span>
                    </div>
                    <div className="ref-item-sub">
                      <span>{whenFull(f.at)}</span>
                      {/* Поки поріг не взято — показуємо, скільки вже
                          внесено: «ещё 150 ₽» зрозуміліше, ніж просто
                          «не пополнил», і видно, що бонус близько. */}
                      <span>
                        {f.depositedAt
                          ? `пополнил ${rub(f.deposited)} ₽`
                          : f.deposited > 0
                            ? `внёс ${rub(f.deposited)} из ${rub(data.depositMin)} ₽`
                            : `+${rub(data.depositRub)} ₽ за пополнение от ${rub(data.depositMin)} ₽`}
                      </span>
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
