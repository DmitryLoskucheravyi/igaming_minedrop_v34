'use client';

/* ============================================================
   FAIRPANEL — панель чесності.

   Тут не «сторінка про те, що ми чесні», а робочі кнопки:
     - видно опублікований sha256(serverSeed) ДО гри;
     - clientSeed можна змінити на свій;
     - «розкрити» закриває серію і показує serverSeed;
     - після цього будь-який раунд серії перераховується ПРЯМО
       в браузері тим самим рушієм, що й на сервері.

   Сам перерахунок живе в hooks/useFairness: там він — звичайна
   функція, яку видно й без React. Тут лише поля й результат.
   ============================================================ */

import { useEffect, useState } from 'react';
import { CONFIG } from '@minedrop/engine';
import type { RevealedSeries } from '../lib/api';
import { Modal } from './Modal';
import { useFairness, useRoundCheck, type Series } from '../hooks/useFairness';

interface Props {
  fair: Series | null;
  onClose: () => void;
}

export function FairPanel({ fair, onClose }: Props) {
  const f = useFairness(fair);
  const [seedInput, setSeedInput] = useState(fair?.clientSeed ?? '');

  /* Сид приїхав із сервера — підставляємо його в поле, але тільки поки
     гравець не почав правити своє. */
  const serverSeed = f.current?.clientSeed;
  useEffect(() => { if (serverSeed) setSeedInput(serverSeed); }, [serverSeed]);

  return (
    <Modal title="Честность раунда" onClose={onClose}>
      {f.error && <p className="err">{f.error}</p>}

      <section>
        <h3>Текущая серия</h3>
        <dl>
          <dt>sha256(serverSeed)</dt>
          <dd className="mono">{f.current?.serverSeedHash ?? '—'}</dd>
          <dt>nonce</dt>
          <dd className="mono">{f.current?.nonce ?? 0}</dd>
        </dl>
        <p className="hint">
          Хеш опубликован до игры. Сид раунда = HMAC(serverSeed, «clientSeed:nonce»).
        </p>

        <div className="row">
          <input
            className="input mono"
            value={seedInput}
            onChange={(e) => setSeedInput(e.target.value)}
            placeholder="свой clientSeed"
            maxLength={128}
          />
          <button
            type="button"
            className="btn"
            disabled={f.busy}
            onClick={() => void f.saveSeed(seedInput)}
          >
            Сохранить
          </button>
        </div>

        <button type="button" className="btn wide" disabled={f.busy} onClick={() => void f.rotate()}>
          Раскрыть сид и начать новую серию
        </button>
      </section>

      {f.revealed.length > 0 && (
        <section>
          <h3>Раскрытые серии</h3>
          {f.revealed.map((s) => (
            <SeriesCheck key={s.serverSeedHash} series={s} onError={f.setError} />
          ))}
        </section>
      )}
    </Modal>
  );
}

/* Одна розкрита серія зі СВОЇМИ полями й СВОЇМ результатом. */
function SeriesCheck({ series, onError }: {
  series: RevealedSeries;
  onError: (m: string | null) => void;
}) {
  const c = useRoundCheck(series);

  return (
    <div className="series">
      <div className="mono small">serverSeed: {series.serverSeed}</div>
      <div className="mono small">clientSeed: {series.clientSeed} · раундов: {series.rounds}</div>

      <div className="row">
        <input className="input mono nn" value={c.nonce}
          onChange={(e) => c.setNonce(e.target.value)} placeholder="nonce" />
        <input className="input mono nn" value={c.bet}
          onChange={(e) => c.setBet(e.target.value)} placeholder="ставка" />
        <button type="button" className="btn" onClick={() => onError(c.verify())}>
          Пересчитать
        </button>
      </div>

      {/* Свій перемикач, а не <input type="checkbox">: системний малює
          браузер — світлий у темній темі, у кожному рушії свій і надто
          дрібний під палець. role="switch" лишає його перемикачем для
          читалки з екрана. */}
      <button
        type="button"
        className="toggle"
        role="switch"
        aria-checked={c.pity}
        onClick={() => c.setPity(!c.pity)}
      >
        <span className="toggle-track" />
        <span>
          гарантированная кирка (каждая {CONFIG.pity + 1}-я ставка после пустых) —
          значение бери из самого раунда
        </span>
      </button>

      {c.result && (
        <div className={'check ' + (c.result.commitOk ? 'ok' : 'bad')}>
          <div>{c.result.commitOk
            ? '✓ serverSeed соответствует опубликованному хешу'
            : '✕ ХЕШ НЕ СОВПАЛ'}</div>
          <div className="mono small">сид: {c.result.seed}</div>
          <div className="mono small">
            прокруты: {c.result.spins}{c.result.pity ? ' (гарантия)' : ''}
          </div>
          <div className="mono small">кирки: {c.result.tiers}</div>
          <div className="payout">выплата: {c.result.payout}</div>
        </div>
      )}
    </div>
  );
}
