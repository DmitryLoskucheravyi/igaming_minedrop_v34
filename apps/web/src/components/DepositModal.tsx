'use client';

/* ============================================================
   DEPOSIT — вікно поповнення балансу.

   Гравець обирає токен (USDT / USDC) і мережу, вводить суму в ₽,
   тисне «Создать заявку» — і БІЛЬШЕ НІЧОГО не тисне: йому видається
   адреса гаманця, точна сума й таймер на 30 хв. Далі він переказує
   кошти ззовні, а сервер (або адмін у CRM) зіставляє переказ і
   зараховує баланс. Якщо за 30 хв нічого не прийшло — заявка стає
   «истёкшей».

   Список мереж НЕ зашитий тут: він приходить із сервера разом із
   рештою даних вікна, бо адмін вмикає й вимикає мережі в CRM на ходу.

   Два місця, де мовчання коштувало б грошей, і тому їх видно на екрані:
     — сума з «хвостиком» (0.0037) переказується ДО останнього знака,
       інакше сервер не впізнає, чия вона;
     — у мережах із коментарем (TON) без цього коментаря переказ
       не опізнається взагалі.
   ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Api, ApiError,
  type DepositNetwork, type Payment, type PaymentsInfo, type TokenId,
} from '../lib/api';
import { Modal } from './Modal';

const QUICK = [500, 1000, 5000];
const rub = (n: number) => Math.round(n).toLocaleString('ru-RU');

/* Останній вибір гравця. Мережу міняють раз і далі поповнюють нею ж —
   змушувати обирати щоразу заново нема сенсу. */
const PICK_KEY = 'minedrop.depositPick';

const STATUS_RU: Record<Payment['status'], string> = {
  pending: 'ожидает оплаты',
  approved: 'зачислено',
  rejected: 'отклонено',
  expired: 'истёк срок',
};

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
  const [info, setInfo] = useState<PaymentsInfo | null>(null);
  const [amount, setAmount] = useState(0);
  const [token, setToken] = useState<TokenId>('usdt');
  const [netId, setNetId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      setInfo(await Api.payments());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // секундна стрілка для таймера
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const nets = useMemo(() => info?.networks ?? [], [info]);

  /** Токени, які взагалі є хоч у якійсь увімкненій мережі. */
  const tokens = useMemo(() => {
    const set = new Set<TokenId>();
    for (const n of nets) for (const t of n.tokens) set.add(t);
    return [...set];
  }, [nets]);

  /** Мережі, де є обраний токен. */
  const options = useMemo(
    () => nets.filter((n) => n.tokens.includes(token)),
    [nets, token]);

  /* Перший показ: піднімаємо минулий вибір, якщо він досі доступний.
     Мережу могли вимкнути в CRM після того, як гравець її обрав, — тоді
     мовчки беремо найдешевшу з доступних. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !nets.length) return;
    restored.current = true;
    try {
      const raw = window.localStorage.getItem(PICK_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { token?: TokenId; network?: string };
        const n = nets.find((x) => x.id === saved.network);
        if (n && saved.token && n.tokens.includes(saved.token)) {
          setToken(saved.token);
          setNetId(n.id);
          return;
        }
      }
    } catch { /* зіпсований запис — просто ігноруємо */ }
    if (!tokens.includes('usdt') && tokens[0]) setToken(tokens[0]);
  }, [nets, tokens]);

  /* Обрана мережа має існувати й підтримувати обраний токен. Інакше
     (перемкнули токен, вимкнули мережу) — найдешевша з можливих. */
  useEffect(() => {
    if (!options.length) { setNetId(null); return; }
    if (options.some((n) => n.id === netId)) return;
    setNetId([...options].sort((a, b) => a.feeUsd - b.feeUsd)[0].id);
  }, [options, netId]);

  const net: DepositNetwork | null = options.find((n) => n.id === netId) ?? null;

  const active = info?.active ?? null;
  const activeId = active?.id ?? null;
  const activeNet = active ? nets.find((n) => n.id === active.network) ?? null : null;

  /* Поллимо статус, поки висить активна заявка.

     Залежність саме від id, а не від об'єкта заявки: кожен полл
     повертає НОВИЙ об'єкт, тому з `active` у залежностях ефект
     перезапускався (і таймер знищувався й створювався) кожні 8 с. */
  useEffect(() => {
    if (!activeId) return;
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [activeId, load]);

  /* Заявка зникла з активних — отже адмін її вирішив (або вона
     протухла). Баланс міг змінитись, а гра про це не знає: сама
     вона ходить на сервер лише за раундом. */
  const prevActiveId = useRef<string | null>(null);
  useEffect(() => {
    if (prevActiveId.current && !activeId) onResolved?.();
    prevActiveId.current = activeId;
  }, [activeId, onResolved]);

  const submit = async () => {
    if (!net || amount < (info?.minRub ?? 100)) return;
    setBusy(true); setErr(null);
    try {
      const p = await Api.createPayment(amount, net.id, token);
      try {
        window.localStorage.setItem(PICK_KEY, JSON.stringify({ token, network: net.id }));
      } catch { /* приватний режим — просто не запам'ятається */ }
      setInfo((prev) => prev ? { ...prev, active: p, history: [p, ...prev.history] } : prev);
      setAmount(0);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать заявку');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* clipboard недоступен */ }
  };

  const left = active ? active.expiresAt - now : 0;
  const min = info?.minRub ?? 100;

  return (
    <Modal title="ПОПОЛНЕНИЕ" onClose={onClose}>
      {err && <p className="err">{err}</p>}

      {!active && (
        <section>
          {info && !nets.length ? (
            <p className="dep-warn">
              Пополнение временно недоступно — приём платежей выключен.
              Напиши в поддержку.
            </p>
          ) : (
            <>
              <span className="dep-label">Монета</span>
              <div className="dep-tokens">
                {tokens.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={'dep-token' + (t === token ? ' on' : '')}
                    onClick={() => setToken(t)}
                  >
                    <Icon src={`/tokens/${t}.png`} alt="" />
                    {t.toUpperCase()}
                  </button>
                ))}
              </div>

              <span className="dep-label">Сеть</span>
              <div className="dep-nets">
                {options.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={'dep-net' + (n.id === netId ? ' on' : '')}
                    onClick={() => setNetId(n.id)}
                  >
                    <Icon src={`/networks/${n.id}.png`} alt="" />
                    <span className="dep-net-name">{n.name}</span>
                    <span className="dep-net-fee">{fee(n.feeUsd)}</span>
                  </button>
                ))}
              </div>
              <p className="dep-est">Комиссия — сети, её платит отправитель. Мы ничего не удерживаем.</p>

              <label className="dep-label" htmlFor="dep-amount">Сумма зачисления, ₽</label>
              <input
                id="dep-amount"
                className="input mono"
                type="number"
                inputMode="numeric"
                min={min}
                value={amount || ''}
                onChange={(e) => setAmount(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                placeholder={`от ${rub(min)}`}
              />
              <div className="dep-chips">
                {QUICK.map((q) => (
                  <button key={q} type="button" className="dep-chip" onClick={() => setAmount((a) => a + q)}>
                    +{rub(q)}
                  </button>
                ))}
              </div>

              <p className="dep-est">
                Точную сумму {token.toUpperCase()} к переводу увидишь после создания заявки.
              </p>

              <button
                type="button"
                className="btn wide"
                disabled={busy || !net || amount < min}
                onClick={() => void submit()}
              >
                {busy ? 'Создаю…' : 'СОЗДАТЬ ЗАЯВКУ'}
              </button>
            </>
          )}
        </section>
      )}

      {active && (
        <section className="dep-active">
          {left > 0 ? (
            <>
              <div className="dep-method">
                <span className="dep-method-badge">
                  <Icon src={`/tokens/${active.token}.png`} alt="" />
                  {active.token.toUpperCase()} · {activeNet?.name ?? active.network}
                </span>
                <span className="dep-method-note">сеть выбрана при создании заявки</span>
              </div>

              <p className="dep-hint">
                Переведи ровно эту сумму на адрес ниже — в той самой сети.
                Больше ничего нажимать не нужно: как только средства придут,
                баланс пополнится.
              </p>

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

              {/* Дробный «хвостик» — не украшение: именно по нему перевод
                  опознают среди прочих. Округлил — деньги повиснут. */}
              {!active.memo && (
                <p className="dep-warn">
                  Переводи сумму <b>до последнего знака</b> — по ней мы и узнаём
                  твой платёж. Округлишь — зачисление придётся искать вручную.
                </p>
              )}

              {/* Курс не приехал с биржи — сумма посчитана по запасному
                  значению. Молчать об этом нельзя: человек переводит
                  реальные деньги по этой цифре. */}
              {active.rateApprox && (
                <p className="dep-warn">
                  ⚠ Курс не удалось обновить, сумма посчитана по запасному
                  ({rub(active.rate)} ₽ за USDT) и может отличаться от рыночной.
                  Перед переводом лучше уточнить у поддержки.
                </p>
              )}

              <span className="dep-label">Адрес{activeNet ? ` (${activeNet.name})` : ''}</span>
              <div className="dep-addr">
                <code>{active.address}</code>
                <button type="button" className="btn" onClick={() => void copy(active.address, 'addr')}>
                  {copied === 'addr' ? '✓' : 'Копировать'}
                </button>
              </div>

              {/* В сетях с комментарием он и есть опознание. Без него
                  перевод приходит «ничей» — и разбирать его придётся
                  руками через поддержку. */}
              {active.memo && (
                <>
                  <span className="dep-label">Комментарий к переводу — обязательно</span>
                  <div className="dep-addr">
                    <code>{active.memo}</code>
                    <button type="button" className="btn" onClick={() => void copy(active.memo!, 'memo')}>
                      {copied === 'memo' ? '✓' : 'Копировать'}
                    </button>
                  </div>
                  <p className="dep-warn">
                    Без этого комментария перевод не опознается автоматически.
                  </p>
                </>
              )}

              <div className={'dep-timer' + (left < 5 * 60_000 ? ' urgent' : '')}>
                осталось {mmss(left)}
              </div>
            </>
          ) : (
            <div className="dep-expired">
              <p>Срок заявки истёк.</p>
              <p className="dep-hint">Если ты уже перевёл средства — напиши в поддержку,
                деньги никуда не делись.
                Иначе создай новую заявку.</p>
              <button type="button" className="btn wide" onClick={() => void load()}>ОБНОВИТЬ</button>
            </div>
          )}
        </section>
      )}

      {info && info.history.length > 0 && (
        <section>
          <h3>Последние</h3>
          <div className="dep-hist">
            {info.history.slice(0, 3).map((p) => (
              <div key={p.id} className={'dep-hist-row st-' + p.status}>
                <span className="dep-hist-amt">{rub(p.amount)} ₽</span>
                <span className="dep-hist-st">{STATUS_RU[p.status]}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </Modal>
  );
}
