'use client';

/* ============================================================
   DEPOSIT — вікно поповнення балансу.

   Гравець обирає монету (USDT / USDC) і мережу, вводить суму в ₽,
   тисне «Создать заявку» — і БІЛЬШЕ НІЧОГО не тисне: йому видається
   адреса гаманця, точна сума й таймер на 30 хв. Далі він переказує
   кошти ззовні, а сервер (або адмін у CRM) зіставляє переказ і
   зараховує баланс. Поки переказу немає, заявку можна зняти самому.

   ТУТ ТІЛЬКИ РОЗМІТКА. Запити, полінг, останній вибір мережі, поправка
   до годинника й межі сум живуть у hooks/useDeposit — файл нижче лише
   показує те, що хук порахував. Раніше все це лежало впереміш, і
   перевірити, скажімо, розрахунок поправки годинника можна було тільки
   відрендеривши вікно цілком.

   Два місця, де мовчання коштувало б грошей, і тому їх видно на екрані:
     — сума з «хвостиком» (0.0037) переказується ДО останнього знака,
       інакше сервер не впізнає, чия вона;
     — у мережах із коментарем (TON) без цього коментаря переказ
       не опізнається взагалі.

   Решта пояснень прибрана навмисно: гравцеві потрібні ЩО зробити і
   СКІЛЬКИ, а не розповідь про те, як влаштоване зіставлення переказів.
   ============================================================ */

import { useState } from 'react';
import type { DepositNetwork, Payment, TokenId } from '../lib/api';
import { Modal } from './Modal';
import { NumField } from '../ui/NumField';
import { useAsk } from '../ui/Ask';
import { useCopy } from '../hooks/useCopy';
import { useDeposit, type DepositState } from '../hooks/useDeposit';
import { PAYMENT_STATUS_RU, rub } from '../lib/format';

const QUICK = [500, 1000, 5000];

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const fee = (usd: number) => (usd < 0.1 ? '<$0.1' : `≈$${usd < 1 ? usd.toFixed(2) : usd.toFixed(0)}`);

/* Іконки лежать у /public і можуть ще не приїхати — тоді просто
   ховаємось, а не показуємо «зламану картинку». */
function Icon({ src, alt }: { src: string; alt: string }) {
  const [bad, setBad] = useState(false);
  if (bad) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="dep-ico" src={src} alt={alt} onError={() => setBad(true)} />;
}

interface Props {
  onClose: () => void;
  /** заявку закрито (погоджено / скасовано / протухла) — перечитати баланс */
  onResolved?: () => void;
}

export function DepositModal({ onClose, onResolved }: Props) {
  const dep = useDeposit(onResolved);
  const ask = useAsk();

  const cancel = async () => {
    if (await ask.confirm('Отменить заявку на пополнение?')) await dep.cancel();
  };

  return (
    <Modal title="Пополнение" onClose={onClose}>
      {dep.error && <p className="err">{dep.error}</p>}

      {!dep.active && (
        dep.info && !dep.info.networks.length
          ? <p className="dep-warn">Пополнение временно недоступно. Напиши в поддержку.</p>
          : <DepositForm dep={dep} />
      )}

      {dep.active && (
        <ActiveDeposit
          active={dep.active}
          network={dep.info?.networks.find((n) => n.id === dep.active!.network) ?? null}
          paid={dep.paid}
          left={dep.left}
          busy={dep.busy}
          onRefresh={dep.reload}
          onCancel={() => void cancel()}
        />
      )}

      {!!dep.info?.history.length && <History rows={dep.info.history} />}

      {/* власний confirm — рендериться поверх вікна */}
      {ask.dialog}
    </Modal>
  );
}

/* ---- вибір монети, мережі й суми ---- */
function DepositForm({ dep }: { dep: DepositState }) {
  return (
    <section>
      <span className="dep-label">Монета</span>
      <div className="dep-tokens">
        {dep.tokens.map((t: TokenId) => (
          <button
            key={t}
            type="button"
            className={'dep-token' + (t === dep.token ? ' on' : '')}
            onClick={() => dep.setToken(t)}
          >
            <Icon src={`/coins/${t}.png`} alt="" />
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      <span className="dep-label">Сеть</span>
      <div className="dep-nets">
        {dep.networks.map((n: DepositNetwork) => (
          <button
            key={n.id}
            type="button"
            className={'dep-net' + (n.id === dep.network?.id ? ' on' : '')}
            onClick={() => dep.setNetwork(n.id)}
          >
            <Icon src={`/networks/${n.id}.png`} alt="" />
            <span className="dep-net-name">{n.name}</span>
            <span className="dep-net-fee">{fee(n.feeUsd)}</span>
          </button>
        ))}
      </div>
      <p className="dep-sub">Комиссию сети платит отправитель.</p>

      <label className="dep-label" htmlFor="dep-amount">Сумма зачисления, ₽</label>
      <div className="dep-field">
        <NumField
          id="dep-amount"
          value={dep.amount}
          onChange={dep.setAmount}
          placeholder={`от ${rub(dep.min)}`}
        />
        {dep.amount > 0 && (
          <button type="button" className="dep-clear" aria-label="Очистить" onClick={() => dep.setAmount(0)}>
            ✕
          </button>
        )}
      </div>

      {dep.estimate > 0 && (
        <p className="dep-sub">
          ≈ {dep.estimate.toFixed(2)} {dep.token.toUpperCase()}
          {dep.info?.rateApprox && ' · курс запасной'}
        </p>
      )}
      {dep.tooBig && <p className="dep-sub">Максимум {rub(dep.max)} ₽</p>}

      <div className="dep-chips">
        {QUICK.map((q) => (
          <button key={q} type="button" className="dep-chip" onClick={() => dep.setAmount(dep.amount + q)}>
            +{rub(q)}
          </button>
        ))}
      </div>

      {/* Промокод перевіряє СЕРВЕР у момент створення заявки, а не це
          поле по ходу набору. Перевірка тут означала б запит на кожну
          літеру й перебір чужих кодів; помилку видно одразу після
          натискання, а введене нікуди не зникає.

          Регістр не чіпаємо навмисно — його нормалізує сервер, а
          примусовий uppercase у полі плутав би того, хто вставляє код
          з оголошення. */}
      <label className="dep-label" htmlFor="dep-promo">Промокод (необязательно)</label>
      <div className="dep-field">
        <input
          id="dep-promo"
          className="dep-promo"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          value={dep.promo}
          placeholder="если есть"
          onChange={(e) => dep.setPromo(e.target.value)}
        />
        {dep.promo && (
          <button
            type="button"
            className="dep-clear"
            aria-label="Очистить"
            onClick={() => dep.setPromo('')}
          >
            ✕
          </button>
        )}
      </div>

      <button
        type="button"
        className="btn wide"
        disabled={!dep.canSubmit}
        onClick={() => void dep.create()}
      >
        {dep.busy ? 'Создаю…' : dep.tooBig ? 'Слишком большая сумма' : 'Создать заявку'}
      </button>
    </section>
  );
}

/* ---- жива заявка: куди, скільки і скільки лишилось ---- */
function ActiveDeposit({ active, network, paid, left, busy, onRefresh, onCancel }: {
  active: Payment;
  network: DepositNetwork | null;
  paid: boolean;
  left: number;
  busy: boolean;
  onRefresh: () => void;
  onCancel: () => void;
}) {
  const { copied, failed, copy } = useCopy();

  /* Переказ уже знайдено в мережі — таймер заявки до нього не має
     стосунку. Без цієї гілки гравець, який переказав на 29-й хвилині,
     через хвилину побачив би «срок истёк» — при тому, що гроші пішли
     і все гаразд. Лякати людину її ж успіхом не можна. */
  if (paid) {
    return (
      <section>
        <div className="dep-expired">
          <p>Перевод найден — ждём подтверждения сети.</p>
          <p className="hint">Ничего делать не нужно.</p>
          <div className="dep-row">
            <span className="dep-k">Получено</span>
            <span className="dep-v big">
              {active.paidAmount ?? active.usdtAmount} <small>{active.token.toUpperCase()}</small>
            </span>
          </div>
          <div className="dep-row">
            <span className="dep-k">К зачислению</span>
            <span className="dep-v">{rub(active.amount)} ₽</span>
          </div>
          <button type="button" className="btn wide" onClick={onRefresh}>Обновить</button>
        </div>
      </section>
    );
  }

  if (left <= 0) {
    return (
      <section>
        <div className="dep-expired">
          <p>Срок заявки истёк.</p>
          <p className="hint">Уже перевёл — напиши в поддержку. Нет — создай новую заявку.</p>
          <button type="button" className="btn wide" onClick={onRefresh}>Обновить</button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="dep-method">
        <span className="dep-method-badge">
          <Icon src={`/coins/${active.token}.png`} alt="" />
          {active.token.toUpperCase()} · {network?.name ?? active.network}
        </span>
        <span className="dep-method-note">сеть выбрана при создании заявки</span>
      </div>

      <div className="dep-row">
        <span className="dep-k">Сумма</span>
        <span className="dep-v big">
          {active.usdtAmount} <small>{active.token.toUpperCase()}</small>
        </span>
      </div>
      <div className="dep-row">
        <span className="dep-k">К зачислению</span>
        <span className="dep-v">{rub(active.amount)} ₽</span>
      </div>

      {/* Надбавка за промокодом. Показуємо саме тут, поруч із сумою
          зарахування: гравець має бачити, що код прийнявся, ДО того як
          переказав гроші — інакше перевіряти обіцянку доведеться вже
          постфактум.

          Слово «бонусом» не прикраса: ці гроші лягають на бонусний
          баланс із відіграшем, і плутати їх із готівкою не можна. */}
      {!!active.promoPercent && (
        <div className="dep-row">
          <span className="dep-k">
            Промокод <b className="dep-promo-code">{active.promo}</b>
          </span>
          <span className="dep-v dep-promo-plus">
            +{rub(Math.round(active.amount * active.promoPercent / 100))} ₽ бонусом
          </span>
        </div>
      )}

      {/* Дробный «хвостик» — не украшение: именно по нему перевод
          опознают среди прочих. Округлил — деньги повиснут. */}
      {!active.memo && (
        <p className="dep-warn">
          Переводи <b>до последнего знака</b> — по сумме мы и узнаём платёж.
        </p>
      )}

      {/* Курс не приехал с биржи — сумма посчитана по запасному значению.
          Молчать нельзя: человек переводит реальные деньги по этой цифре. */}
      {active.rateApprox && (
        <p className="dep-warn">
          Курс запасной ({rub(active.rate)} ₽ за USDT) — сверь с поддержкой.
        </p>
      )}

      {failed && <p className="dep-sub">Буфер обмена недоступен — выдели и скопируй вручную.</p>}

      <span className="dep-label">Адрес{network ? ` (${network.name})` : ''}</span>
      <div className="dep-addr">
        <code>{active.address}</code>
        <button type="button" className="btn" onClick={() => void copy(active.address, 'addr')}>
          {copied === 'addr' ? '✓' : 'Копировать'}
        </button>
      </div>

      {/* В сетях с комментарием он и есть опознание. Без него перевод
          приходит «ничей», и разбирать его придётся руками. */}
      {active.memo && (
        <>
          <span className="dep-label">Комментарий к переводу — обязательно</span>
          <div className="dep-addr">
            <code>{active.memo}</code>
            <button type="button" className="btn" onClick={() => void copy(active.memo!, 'memo')}>
              {copied === 'memo' ? '✓' : 'Копировать'}
            </button>
          </div>
          <p className="dep-warn">Без комментария перевод <b>не опознается</b>.</p>
        </>
      )}

      <div className={'dep-timer' + (left < 5 * 60_000 ? ' urgent' : '')}>
        осталось {mmss(left)}
      </div>

      {/* Поки переказу немає — заявку можна зняти. Без цього помилка в
          сумі чи мережі коштувала 30 хвилин: друга заявка не
          створюється, доки висить перша. */}
      <button type="button" className="btn wide danger" disabled={busy} onClick={onCancel}>
        {busy ? '…' : 'Отменить заявку'}
      </button>
    </section>
  );
}

/* ---- три останні заявки ---- */
function History({ rows }: { rows: Payment[] }) {
  return (
    <section>
      <h3>Последние</h3>
      <div className="dep-hist">
        {rows.slice(0, 3).map((p) => (
          <div key={p.id} className={'dep-hist-row st-' + p.status}>
            <span className="dep-hist-amt">{rub(p.amount)} ₽</span>
            <span className="dep-hist-st">{PAYMENT_STATUS_RU[p.status]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
