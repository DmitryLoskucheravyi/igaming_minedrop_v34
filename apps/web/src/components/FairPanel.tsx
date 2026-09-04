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
import { resolveRound, roundSeed, verifyCommit, type RoundMode } from '@minedrop/engine';
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
  const [mode, setMode] = useState<RoundMode>('bet');
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
      setErr('nonce і ставка мають бути додатними числами');
      return;
    }
    setErr(null);
    const seed = roundSeed(series.serverSeed, series.clientSeed, n);
    const r = resolveRound(seed, mode, b);
    setCheck({
      commitOk: verifyCommit(series.serverSeed, series.serverSeedHash),
      seed,
      payout: r.payout,
      spins: r.setup.spins.map((s) => s ?? '—').join(' '),
      tiers: r.setup.tiers.join(', ') || 'кірка не випала',
    });
  };

  return (
    <div className="modal" role="dialog" aria-label="Чесність раунду">
      <div className="modalbox">
        <div className="modalhead">
          <h2>ЧЕСНІСТЬ РАУНДУ</h2>
          <button type="button" className="x" onClick={onClose}>✕</button>
        </div>

        {err && <p className="err">{err}</p>}

        <section>
          <h3>Поточна серія</h3>
          <dl>
            <dt>sha256(serverSeed)</dt>
            <dd className="mono">{current?.serverSeedHash ?? '—'}</dd>
            <dt>nonce</dt>
            <dd className="mono">{current?.nonce ?? 0}</dd>
          </dl>
          <p className="hint">
            Хеш опубліковано до гри. Сид раунду = HMAC(serverSeed, «clientSeed:nonce»).
            Поки серія відкрита, serverSeed не показується — інакше можна було б
            рахувати результат наперед.
          </p>

          <div className="row">
            <input
              className="input mono"
              value={seedInput}
              onChange={(e) => setSeedInput(e.target.value)}
              placeholder="свій clientSeed"
              maxLength={128}
            />
            <button type="button" className="btn" disabled={busy} onClick={saveSeed}>ЗБЕРЕГТИ</button>
          </div>

          <button type="button" className="btn wide" disabled={busy} onClick={rotate}>
            РОЗКРИТИ СИД І ПОЧАТИ НОВУ СЕРІЮ
          </button>
        </section>

        {revealed.length > 0 && (
          <section>
            <h3>Розкриті серії</h3>
            {revealed.map((s) => (
              <div key={s.serverSeedHash} className="series">
                <div className="mono small">serverSeed: {s.serverSeed}</div>
                <div className="mono small">clientSeed: {s.clientSeed} · раундів: {s.rounds}</div>

                <div className="row">
                  <input className="input mono nn" value={nonce} onChange={(e) => setNonce(e.target.value)} placeholder="nonce" />
                  <input className="input mono nn" value={bet} onChange={(e) => setBet(e.target.value)} placeholder="ставка" />
                  <select className="input" value={mode} onChange={(e) => setMode(e.target.value as RoundMode)}>
                    <option value="bet">звичайна</option>
                    <option value="bonus-buy">куплена бонуска</option>
                    <option value="bonus-streak">бонуска за стрік</option>
                  </select>
                  <button type="button" className="btn" onClick={() => verifyRound(s)}>ПЕРЕРАХУВАТИ</button>
                </div>
              </div>
            ))}

            {check && (
              <div className={'check ' + (check.commitOk ? 'ok' : 'bad')}>
                <div>{check.commitOk ? '✓ serverSeed відповідає опублікованому хешу' : '✕ ХЕШ НЕ ЗІЙШОВСЯ'}</div>
                <div className="mono small">сид: {check.seed}</div>
                <div className="mono small">прокрути: {check.spins}</div>
                <div className="mono small">кірки: {check.tiers}</div>
                <div className="payout">виплата: {check.payout}</div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
