'use client';

/* ============================================================
   ПАКЕТИ ФРІСПІНІВ — список, що гортається.

   Один пакет = один рядок = намальований банер (public/spins) із
   порожніми панелями, у які компонент вписує назву, кількість
   прокрутів, множник шансу й ціну. Права панель — не напис, а САМА
   КНОПКА покупки: окрема кнопка під банером дублювала б намальоване й
   ламала б рядок навпіл.

   Вікно нічого не рахує: пакети, ціни й множник приходять із сервера,
   покупку робить теж він. Тут лише розмітка й натискання.

   Виграш із цих прокрутів — ЗВИЧАЙНІ гроші, без відіграшу: пакет
   куплено за власні, а відіграш вішають на подарунки (див.
   spins.types на сервері).
   ============================================================ */

import { useEffect, useState } from 'react';
import { Api, type SpinsState } from '../lib/api';
import { Modal } from './Modal';
import { SPIN_BANNERS, plateStyle } from '../lib/spin-banners';
import { rub } from '../lib/format';

interface Props {
  onClose: () => void;
  /** пакет куплено — перечитати баланс */
  onBought?: () => void;
}

export function SpinsModal({ onClose, onBought }: Props) {
  const [state, setState] = useState<SpinsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Api.spins()
      .then((s) => alive && setState(s))
      .catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, []);

  const buy = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const r = await Api.buySpins(id);
      setState((prev) => (prev ? { ...prev, left: r.left, bet: r.bet, balance: r.balance } : prev));
      onBought?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Фриспины" onClose={onClose}>
      {error && <p className="err">{error}</p>}
      {!state && !error && <p className="hint">Загрузка…</p>}

      {state && state.left > 0 && (
        <p className="fs-left">
          У тебя <b>{state.left}</b> прокрутов по {rub(state.bet)} ₽.
          Они сыграют сами при следующем спине.
        </p>
      )}

      {state && state.left === 0 && (
        <>
          <p className="dep-sub">
            Шанс кирки в этих прокрутах в <b>x{state.chanceX}</b> выше обычного.
            Выигрыш — обычные деньги, выводится без отыгрыша.
          </p>

          <div className="fs-list">
            {state.packs.map((p) => {
              const banner = SPIN_BANNERS[p.id];
              const enough = state.balance >= p.price;
              /* Банера на пакет може не бути (додали пакет, картинку ще
                 не намалювали) — тоді показуємо рядок без картинки, а не
                 ховаємо пакет: інакше він мовчки зникне з продажу. */
              return (
                <div key={p.id} className={'fs-row' + (banner ? '' : ' bare')}>
                  {banner && (
                    <img className="fs-banner" src={banner.src} alt="" draggable={false} />
                  )}

                  <div
                    className="fs-plate fs-name"
                    style={banner ? plateStyle(banner.geom.title) : undefined}
                  >
                    {p.name}
                  </div>

                  <div
                    className="fs-plate fs-stat"
                    style={banner ? plateStyle(banner.geom.left) : undefined}
                  >
                    <b>{p.spins}</b>
                    <span>прокрутов</span>
                  </div>

                  <div
                    className="fs-plate fs-stat"
                    style={banner ? plateStyle(banner.geom.right) : undefined}
                  >
                    <b>{rub(p.bet)} ₽</b>
                    <span>ставка</span>
                  </div>

                  <button
                    type="button"
                    className={'fs-plate fs-buy' + (enough ? '' : ' off')}
                    style={banner ? plateStyle(banner.geom.price) : undefined}
                    disabled={!enough || busy !== null}
                    onClick={() => void buy(p.id)}
                  >
                    {busy === p.id ? '…' : enough ? <>{rub(p.price)} ₽</> : 'мало'}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
