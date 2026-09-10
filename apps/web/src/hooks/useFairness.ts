'use client';

/* ============================================================
   USEFAIRNESS — серія provably-fair і локальний перерахунок раунду.

   Дві різні речі, і тому два хуки, а не один:

     useFairness  — розмова з сервером: поточний хеш, зміна clientSeed,
                    розкриття серії.
     useRoundCheck — рахунок ПРЯМО В БРАУЗЕРІ, без жодного запиту: той
                    самий resolveRound із @minedrop/engine, яким рахує
                    виплату сервер. У цьому й полягає перевірка — якщо
                    перерахунок ішов би на сервер, вона нічого не
                    доводила б.

   PITY. Кожна CONFIG.pity-та порожня ставка поспіль форсує кірку: з
   таблиці прокруту прибирається «пусто», і той самий сид дає ІНШИЙ
   результат. Тому прапорець мусить збігатися з тим, як раунд грався.
   ============================================================ */

import { useCallback, useState } from 'react';
import { resolveRound, roundSeed, verifyCommit } from '@minedrop/engine';
import { Api, type RevealedSeries } from '../lib/api';
import { useResource } from './useResource';

export interface Series {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

interface Fairness {
  current: Series;
  revealed: RevealedSeries[];
}

export function useFairness(initial: Series | null) {
  const res = useResource<Fairness>(() => Api.fairness());
  const { data, error, setData, setError } = res;
  const [busy, setBusy] = useState(false);

  /* Поки відповідь не приїхала, показуємо те, що вже знає HUD: він
     отримав хеш серії разом зі станом гравця, і блимати порожнім
     екраном заради повторного запиту нема сенсу. */
  const current = data?.current ?? initial;
  const revealed = data?.revealed ?? [];

  const saveSeed = useCallback(async (seed: string) => {
    setBusy(true); setError(null);
    try {
      const p = await Api.setClientSeed(seed);
      setData((prev) => ({
        current: { serverSeedHash: p.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce },
        revealed: prev?.revealed ?? [],
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [setData, setError]);

  const rotate = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await Api.rotate();
      setData((prev) => ({
        current: {
          serverSeedHash: r.next.serverSeedHash,
          clientSeed: prev?.current.clientSeed ?? '',
          nonce: 0,
        },
        revealed: [r.revealed, ...(prev?.revealed ?? [])],
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [setData, setError]);

  return { current, revealed, error, busy, saveSeed, rotate, setError };
}

export interface CheckResult {
  commitOk: boolean;
  seed: string;
  payout: number;
  spins: string;
  tiers: string;
  pity: boolean;
}

/* Перерахунок однієї розкритої серії. Свій стан на КОЖНУ серію, а не
   один на панель: інакше введений для однієї серії nonce рахувався б
   у другій, а результат підмінювався б одразу під усіма. */
export function useRoundCheck(series: RevealedSeries) {
  const [nonce, setNonce] = useState('1');
  const [bet, setBet] = useState('50');
  const [pity, setPity] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);

  /** null — усе гаразд; рядок — що саме не так із введеним. */
  const verify = useCallback((): string | null => {
    const n = parseInt(nonce, 10);
    const b = parseInt(bet, 10);
    if (!Number.isFinite(n) || n < 1 || !Number.isFinite(b) || b < 1) {
      return 'nonce и ставка должны быть положительными числами';
    }
    const seed = roundSeed(series.serverSeed, series.clientSeed, n);
    const r = resolveRound(seed, 'bet', b, pity);
    setResult({
      commitOk: verifyCommit(series.serverSeed, series.serverSeedHash),
      seed,
      payout: r.payout,
      pity: r.setup.pity,
      spins: r.setup.spins.map((x) => x ?? '—').join(' '),
      tiers: r.setup.tiers.join(', ') || 'кирка не выпала',
    });
    return null;
  }, [nonce, bet, pity, series]);

  return { nonce, setNonce, bet, setBet, pity, setPity, result, verify };
}
