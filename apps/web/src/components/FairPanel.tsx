'use client';

/* ============================================================
   FAIRPANEL — панель чесності.

   Тут не «сторінка про те, що ми чесні», а робочі кнопки:
     - видно опублікований sha256(serverSeed) ДО гри;
     - clientSeed можна змінити на свій;
     - «розкрити» закриває серію і показує serverSeed;
     - після цього будь-який раунд серії перераховується ПРЯМО
       в браузері тим самим рушієм, що й на сервері.

   Перевірка справжня: resolveRound() тут — той самий код, який
   рахував виплату на бекенді.
   ============================================================ */

import { useEffect, useState } from 'react';
import { resolveRound, roundSeed, verifyCommit } from '@minedrop/engine';
import { Api, type RevealedSeries } from '../lib/api';

interface Props {
  fair: { serverSeedHash: string; clientSeed: string; nonce: number } | null;
  onClose: () => void;
}

interface CheckResult {
  commitOk: boolean;
  seed: string;
  payout: number;
  spins: string;
  tiers: string;
}

export function FairPanel({ fair, onClose }: Props) {
  const [current, setCurrent] = useState(fair);
  const [revealed, setRevealed] = useState<RevealedSeries[]>([]);
  const [seedInput, setSeedInput] = useState(fair?.clientSeed ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [nonce, setNonce] = useState('1');
  const [bet, setBet] = useState('50');
  const [check, setCheck] = useState<CheckResult | null>(null);

  useEffect(() => {
    Api.fairness()
      .then((f) => { setCurrent(f.current); setRevealed(f.revealed); setSeedInput(f.current.clientSeed); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const saveSeed = async () => {
    setBusy(true); setErr(null);
    try {
      const p = await Api.setClientSeed(seedInput);
      setCurrent({ serverSeedHash: p.serverSeedHash, clientSeed: p.clientSeed, nonce: p.nonce });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const rotate = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await Api.rotate();
      setRevealed((prev) => [r.revealed, ...prev]);
      setCurrent((c) => c && { ...c, serverSeedHash: r.next.serverSeedHash, nonce: 0 });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  /* Локальний перерахунок — жодного запиту на сервер */
  const verifyRound = (series: RevealedSeries) => {
    const n = parseInt(nonce, 10);
    const b = parseInt(bet, 10);
    if (!Number.isFinite(n) || n < 1 || !Number.isFinite(b) || b < 1) {
      setErr('nonce и ставка должны быть положительными числами');
      return;
    }
    setErr(null);
    const seed = roundSeed(series.serverSeed, series.clientSeed, n);
    const r = resolveRound(seed, 'bet', b);
    setCheck({
      commitOk: verifyCommit(series.serverSeed, series.serverSeedHash),
      seed,
      payout: r.payout,
      spins: r.setup.spins.map((s) => s ?? '—').join(' '),
      tiers: r.setup.tiers.join(', ') || 'кирка не выпала',
    });
  };

  return (
    <div className="modal" role="dialog" aria-label="Честность раунда">
      <div className="modalbox">
        <div className="modalhead">
          <h2>ЧЕСТНОСТЬ РАУНДА</h2>
          <button type="button" className="x" onClick={onClose}>✕</button>
        </div>

        {err && <p className="err">{err}</p>}

        <section>
          <h3>Текущая серия</h3>
          <dl>
            <dt>sha256(serverSeed)</dt>
            <dd className="mono">{current?.serverSeedHash ?? '—'}</dd>
            <dt>nonce</dt>
            <dd className="mono">{current?.nonce ?? 0}</dd>
          </dl>
          <p className="hint">
            Хеш опубликован до игры. Сид раунда = HMAC(serverSeed, «clientSeed:nonce»).
            Пока серия открыта, serverSeed не показывается — иначе можно было бы
            посчитать результат заранее.
          </p>

          <div className="row">
            <input
              className="input mono"
              value={seedInput}
              onChange={(e) => setSeedInput(e.target.value)}
              placeholder="свой clientSeed"
              maxLength={128}
            />
            <button type="button" className="btn" disabled={busy} onClick={saveSeed}>СОХРАНИТЬ</button>
          </div>

          <button type="button" className="btn wide" disabled={busy} onClick={rotate}>
            РАСКРЫТЬ СИД И НАЧАТЬ НОВУЮ СЕРИЮ
          </button>
        </section>

        {revealed.length > 0 && (
          <section>
            <h3>Раскрытые серии</h3>
            {revealed.map((s) => (
              <div key={s.serverSeedHash} className="series">
                <div className="mono small">serverSeed: {s.serverSeed}</div>
                <div className="mono small">clientSeed: {s.clientSeed} · раундов: {s.rounds}</div>

                <div className="row">
                  <input className="input mono nn" value={nonce} onChange={(e) => setNonce(e.target.value)} placeholder="nonce" />
                  <input className="input mono nn" value={bet} onChange={(e) => setBet(e.target.value)} placeholder="ставка" />
                  <button type="button" className="btn" onClick={() => verifyRound(s)}>ПЕРЕСЧИТАТЬ</button>
                </div>
              </div>
            ))}

            {check && (
              <div className={'check ' + (check.commitOk ? 'ok' : 'bad')}>
                <div>{check.commitOk ? '✓ serverSeed соответствует опубликованному хешу' : '✕ ХЕШ НЕ СОВПАЛ'}</div>
                <div className="mono small">сид: {check.seed}</div>
                <div className="mono small">прокруты: {check.spins}</div>
                <div className="mono small">кирки: {check.tiers}</div>
                <div className="payout">выплата: {check.payout}</div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
