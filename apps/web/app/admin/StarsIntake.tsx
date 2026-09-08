'use client';

/* ============================================================
   ДЕПОЗИТЫ → TG STARS — заготовка.

   Вкладка есть, приёма нет: Stars — это не ещё одна сеть, а другой
   способ оплаты целиком. Деньги идут через Telegram (invoice в
   валюте XTR, подтверждение pre_checkout_query, событие
   successful_payment у бота), никакого адреса и никакого блокчейна
   там не участвует, а курс Stars→₽ задаём мы сами.

   Поэтому здесь не заглушка «скоро», а честный список того, из чего
   это состоит: чтобы, когда дойдут руки, не выяснять заново.
   ============================================================ */

import s from './admin.module.css';

export function StarsIntake() {
  return (
    <>
      <div className={s.watchBar}>
        <span className={`${s.badge} ${s.expired}`}>Не подключено</span>
        <span className={s.dim}>приём звёзд ещё не сделан — вкладка под него</span>
      </div>

      <p className={s.dim} style={{ maxWidth: 720, lineHeight: 1.7 }}>
        Stars — не сеть, а отдельный способ оплаты: деньги идут через Telegram,
        адреса и блокчейна там нет вообще. Поэтому сюда не подходит ничего
        из соседней вкладки — ни адреса, ни режимы наблюдателя, ни сопоставление
        переводов по сумме.
      </p>

      <h2 className={s.sect}>Из чего это состоит</h2>
      <div className={s.netGrid}>
        <div className={s.netCard}>
          <span className={s.netTop}><span className={s.netName}>Счёт в боте</span></span>
          <span className={s.netSub}>
            бот выставляет invoice в валюте XTR и подтверждает pre_checkout_query —
            без ответа на него оплата у игрока просто не пройдёт
          </span>
        </div>
        <div className={s.netCard}>
          <span className={s.netTop}><span className={s.netName}>Курс ★ → ₽</span></span>
          <span className={s.netSub}>
            задаём мы сами и здесь же меняем: у звёзд нет биржевого курса,
            в отличие от USDT
          </span>
        </div>
        <div className={s.netCard}>
          <span className={s.netTop}><span className={s.netName}>Зачисление</span></span>
          <span className={s.netSub}>
            по событию successful_payment, сразу и без человека: Telegram уже
            подтвердил платёж, сверять нечего
          </span>
        </div>
        <div className={s.netCard}>
          <span className={s.netTop}><span className={s.netName}>Возвраты</span></span>
          <span className={s.netSub}>
            Telegram разрешает вернуть звёзды — значит, нужен свой список
            оплат с id транзакции, иначе возврат нечем закрыть
          </span>
        </div>
      </div>

      <p className={s.dim} style={{ marginTop: 16 }}>
        Ничего из этого не начато. Скажи — сделаю отдельным заходом.
      </p>
    </>
  );
}
