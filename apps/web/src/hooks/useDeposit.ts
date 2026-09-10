'use client';

/* ============================================================
   USEDEPOSIT — уся логіка поповнення, без жодного рядка розмітки.

   ЧОМУ ОКРЕМО ВІД ВІКНА. DepositModal тримав одинадцять useState і сім
   useEffect: запит, полінг раз на 8 с, localStorage з останнім вибором,
   поправку до годинника телефону, межі сум, оцінку в USDT, таймер,
   створення й скасування заявки — і між усім цим розмітку. Перевірити
   там не можна було нічого: щоб дізнатись, чи правильно рахується
   поправка годинника, довелось би рендерити вікно.

   Тепер вікно рендерить те, що йому дали, а правила живуть тут і
   викликаються як звичайна функція.

   Хук СКЛАДЕНИЙ із трьох менших, а не написаний однією купою:
   useResource тягне дані, usePick пам'ятає вибір монети й мережі,
   useNow цокає таймером. Кожен займається одним.
   ============================================================ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Api, ApiError,
  type DepositNetwork, type NetworkId, type Payment, type PaymentsInfo, type TokenId,
} from '../lib/api';
import { useNow, usePoll, useResource } from './useResource';

/* Останній вибір гравця. Мережу міняють раз і далі поповнюють нею ж —
   змушувати обирати щоразу заново нема сенсу. */
const PICK_KEY = 'minedrop.depositPick';
const POLL_MS = 8000;

interface Pick { token?: TokenId; network?: NetworkId }

const readPick = (): Pick => {
  try {
    const raw = window.localStorage.getItem(PICK_KEY);
    return raw ? JSON.parse(raw) as Pick : {};
  } catch { return {}; }          // зіпсований запис — просто ігноруємо
};

const savePick = (p: Pick): void => {
  try { window.localStorage.setItem(PICK_KEY, JSON.stringify(p)); }
  catch { /* приватний режим — просто не запам'ятається */ }
};

export interface DepositState {
  info: PaymentsInfo | null;
  error: string | null;
  busy: boolean;
  /** заявка, яка чекає переказу або дозріває в мережі */
  active: Payment | null;
  /** переказ уже знайдено в мережі — таймер до неї не стосується */
  paid: boolean;
  /** скільки лишилось до кінця заявки, мс (з поправкою на годинник) */
  left: number;

  tokens: TokenId[];
  networks: DepositNetwork[];
  token: TokenId;
  setToken: (t: TokenId) => void;
  network: DepositNetwork | null;
  setNetwork: (id: NetworkId) => void;

  amount: number;
  setAmount: (n: number) => void;
  min: number;
  max: number;
  /** скільки вийде в токені за поточним курсом (0 — рахувати нема з чого) */
  estimate: number;
  tooBig: boolean;
  canSubmit: boolean;

  create: () => Promise<void>;
  cancel: () => Promise<boolean>;
  reload: () => void;
}

export function useDeposit(onResolved?: () => void): DepositState {
  const res = useResource<PaymentsInfo>(() => Api.payments());
  const { data: info, error, reload, setData, setError } = res;

  const [amount, setAmount] = useState(0);
  const [token, setToken] = useState<TokenId>('usdt');
  const [netId, setNetId] = useState<NetworkId | null>(null);
  const [busy, setBusy] = useState(false);

  /* Поправка до годинника телефону. Таймер заявки — це expiresAt мінус
     «зараз»; на збитому годиннику людина побачила б «срок истёк» на
     живій заявці. Сервер віддає свій час — різницю тримаємо тут. */
  const skew = useRef(0);
  useEffect(() => { if (info) skew.current = info.now - Date.now(); }, [info]);

  const active = info?.active ?? null;
  const activeId = active?.id ?? null;
  const paid = active?.status === 'processing';

  /* Полимо, лише поки є що чекати. Залежність саме від id, а не від
     об'єкта заявки: кожна відповідь повертає НОВИЙ об'єкт, і на ньому
     інтервал перестворювався б щовісім секунд. */
  usePoll(() => void reload(), POLL_MS, !!activeId);

  const now = useNow(!!activeId);
  const left = active ? active.expiresAt - (now + skew.current) : 0;

  /* Заявка зникла з активних — її вирішили (або вона протухла). Баланс
     міг змінитись, а гра сама на сервер поза раундами не ходить. */
  const prevActive = useRef<string | null>(null);
  useEffect(() => {
    if (prevActive.current && !activeId) onResolved?.();
    prevActive.current = activeId;
  }, [activeId, onResolved]);

  const nets = useMemo(() => info?.networks ?? [], [info]);

  /** Монети, які взагалі є хоч у якійсь увімкненій мережі. */
  const tokens = useMemo(() => {
    const set = new Set<TokenId>();
    for (const n of nets) for (const t of n.tokens) set.add(t);
    return [...set];
  }, [nets]);

  /** Мережі, де є обрана монета. */
  const options = useMemo(
    () => nets.filter((n) => n.tokens.includes(token)), [nets, token]);

  /* Перший показ: піднімаємо минулий вибір, якщо він досі доступний.
     Мережу могли вимкнути в CRM після того, як гравець її обрав. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !nets.length) return;
    restored.current = true;
    const saved = readPick();
    const n = nets.find((x) => x.id === saved.network);
    if (n && saved.token && n.tokens.includes(saved.token)) {
      setToken(saved.token);
      setNetId(n.id);
      return;
    }
    if (!tokens.includes('usdt') && tokens[0]) setToken(tokens[0]);
  }, [nets, tokens]);

  /* Обрана мережа має існувати й підтримувати обрану монету. Інакше
     (перемкнули монету, вимкнули мережу) — найдешевша з можливих. */
  useEffect(() => {
    if (!options.length) { setNetId(null); return; }
    if (options.some((n) => n.id === netId)) return;
    setNetId([...options].sort((a, b) => a.feeUsd - b.feeUsd)[0].id);
  }, [options, netId]);

  const network = options.find((n) => n.id === netId) ?? null;
  const min = info?.minRub ?? 100;
  /* Стеля приходить із сервера й там же перевіряється. Не спитати про
     неї тут означало б дати натиснути й отримати 400. */
  const max = info?.maxRub ?? Infinity;
  const tooBig = amount > max;
  const estimate = info?.rate && amount > 0 ? amount / info.rate : 0;
  const canSubmit = !busy && !!network && amount >= min && !tooBig;

  const create = useCallback(async () => {
    if (!network || amount < min || amount > max) return;
    setBusy(true); setError(null);
    try {
      const p = await Api.createPayment(amount, network.id, token);
      savePick({ token, network: network.id });
      /* Відповідь сервера вже містить готову заявку — другий запит по
         неї був би зайвим обміном на найповільнішому екрані. */
      setData((prev) => prev ? { ...prev, active: p, history: [p, ...prev.history] } : prev);
      setAmount(0);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось создать заявку');
    } finally {
      setBusy(false);
    }
  }, [network, amount, min, max, token, setData, setError]);

  /** true — заявку знято; підтвердження питає вікно, не хук. */
  const cancel = useCallback(async () => {
    if (!active) return false;
    setBusy(true); setError(null);
    try {
      await Api.cancelPayment(active.id);
      await reload();
      onResolved?.();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось отменить');
      return false;
    } finally {
      setBusy(false);
    }
  }, [active, reload, setError, onResolved]);

  return {
    info, error, busy, active, paid, left,
    tokens, networks: options, token, setToken, network, setNetwork: setNetId,
    amount, setAmount, min, max, estimate, tooBig, canSubmit,
    create, cancel, reload: () => void reload(),
  };
}
