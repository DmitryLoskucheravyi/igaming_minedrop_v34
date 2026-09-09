'use client';

/* ============================================================
   ДЕПОЗИТЫ → КРИПТО — вся цепочка «что принимаем → куда придёт»
   на одном экране.

   Раньше это жило в двух вкладках: режим с сетями в одной, адреса в
   другой. Разделять их было нечем: сеть без адреса своего семейства
   не работает, а адрес без включённой сети не слушается. Ошибка
   вылезала не здесь, а у игрока в момент перевода.

   Порядок сверху вниз повторяет порядок решений: насколько доверяем
   боту → какие монеты → какие сети → на какие адреса. Каждый блок
   показывает, чем он оборачивается в соседнем: у сети видно адрес,
   у адреса — сети, которые он обслуживает.

   Адреса динамические: наблюдатель спрашивает список каждый цикл, а
   не читает на старте. Поэтому строка «бот слушает» — не пересказ
   намерения, а буквально его рабочий список, посчитанный тем же кодом.
   ============================================================ */

import { useCallback, useEffect, useState } from 'react';
import s from './admin.module.css';
import {
  api, when, FAMILY_RU, MODE_RU,
  type AdminAddress, type CatalogueNetwork, type DepositCatalogue,
  type DepositMode, type DepositSettings, type Family, type TokenId,
  type WatchTarget,
} from './lib';
import { useAsk } from './Ask';

const MODES: DepositMode[] = ['off', 'watch', 'semi', 'auto'];
const FAMILIES: Family[] = ['evm', 'tron', 'ton', 'solana'];

/* Формат адреса — подсказкой рядом с полем, а не в голове. Завести
   адрес не в то семейство можно молча, а выясняется это только когда
   игрок уже перевёл деньги. */
const HINT: Record<Family, string> = {
  evm: '0x… — 42 символа',
  tron: 'T… — 34 символа',
  ton: 'EQ… / UQ…',
  solana: 'base58, 32-44 символа',
};

const fee = (usd: number) => (usd < 0.1 ? '<$0.1' : `≈$${usd < 1 ? usd.toFixed(2) : usd.toFixed(0)}`);

interface Payload {
  settings: DepositSettings;
  addresses: AdminAddress[];
  watching: WatchTarget[];
  catalogue: DepositCatalogue;
}

export function CryptoIntake() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Форма добавления открыта для одного семейства за раз: адрес всегда
     заводится в конкретное, и вопрос «в какое» не должен возникать. */
  const [adding, setAdding] = useState<Family | null>(null);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  /* Окремо від busy: той стосується форми зверху (режим/монети/мережі).
     Тут — множина ID адрес, чий Вкл/Викл зараз у польоті: швидкий
     подвійний клік по ОДНІЙ і тій самій адресі не відправить два PATCH
     одночасно, а перемикання ІНШИХ адрес тим часом не блокується. */
  const [addrBusy, setAddrBusy] = useState<ReadonlySet<string>>(() => new Set());
  const ask = useAsk();

  const load = useCallback(async () => {
    try {
      setData(await api<Payload>('/deposit-settings'));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /* Пишем сразу, без кнопки «Сохранить»: она создала бы состояние
     «на экране одно, на сервере другое». Экран обновляем оптимистично,
     при ошибке перечитываем — рассинхрон дороже мгновенного отклика. */
  const save = async (patch: Partial<DepositSettings>) => {
    if (!data) return;
    setData({ ...data, settings: { ...data.settings, ...patch } });
    setBusy(true); setErr(null);
    try {
      await api('/deposit-settings', { method: 'POST', body: JSON.stringify(patch) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      // перечитываем всегда: от режима и сетей зависит список наблюдения
      await load();
    }
  };

  const toggleNet = (id: string) => {
    if (!data) return;
    const on = data.settings.networks.includes(id);
    void save({
      networks: on
        ? data.settings.networks.filter((x) => x !== id)
        : [...data.settings.networks, id],
    });
  };

  const toggleToken = (id: TokenId) => {
    if (!data) return;
    const on = data.settings.tokens.includes(id);
    void save({
      tokens: on ? data.settings.tokens.filter((x) => x !== id) : [...data.settings.tokens, id],
    });
  };

  const addAddress = async (family: Family) => {
    if (!address.trim()) return;
    setBusy(true); setErr(null);
    try {
      await api('/addresses', {
        method: 'POST',
        body: JSON.stringify({ family, address: address.trim(), label: label.trim() || undefined }),
      });
      setAddress(''); setLabel(''); setAdding(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const toggleAddr = async (a: AdminAddress) => {
    if (addrBusy.has(a.id)) return;   // попередній перемикач цієї ж адреси ще в польоті
    setAddrBusy((prev) => new Set(prev).add(a.id));
    setErr(null);
    try {
      await api(`/addresses/${a.id}`, {
        method: 'POST', body: JSON.stringify({ active: !a.active }),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    await load();
    setAddrBusy((prev) => { const next = new Set(prev); next.delete(a.id); return next; });
  };

  const renameAddr = async (a: AdminAddress) => {
    const next = await ask.prompt('Заголовок адреса', 'Чтобы не путать адреса между собой', a.label ?? '');
    if (next === null) return;
    try {
      await api(`/addresses/${a.id}`, { method: 'POST', body: JSON.stringify({ label: next }) });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const removeAddr = async (a: AdminAddress) => {
    const text = a.pending > 0
      ? `На адресе ${a.pending} активн. заявок — игроки уже переводят на неё. Всё равно удалить?`
      : 'Удалить адрес? Наблюдатель перестанет его слушать.';
    if (!(await ask.confirm(text, true))) return;
    try {
      await api(`/addresses/${a.id}/delete`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!data) {
    return err ? <div className={s.err}>{err}</div> : <div className={s.empty}>Загрузка…</div>;
  }

  const { settings: cfg, catalogue: cat, addresses, watching } = data;

  const hasAddr = (f: Family) => addresses.some((a) => a.active && a.family === f);

  /** сети семейства, включённые прямо сейчас — их и обслуживает адрес */
  const netsOf = (f: Family) =>
    cat.networks.filter((n) => n.family === f && cfg.networks.includes(n.id));

  /* Почему сеть не работает, хотя включена. Порядок проверок — от того,
     что чинится быстрее: адрес завести проще, чем разбираться с монетами. */
  const broken = (n: CatalogueNetwork): string | null => {
    if (!cfg.networks.includes(n.id)) return null;
    if (!hasAddr(n.family)) return `нет адреса ${FAMILY_RU[n.family]}`;
    if (!n.tokens.some((t) => cfg.tokens.includes(t))) return 'ни одна монета не включена';
    return null;
  };

  const liveNets = new Set(watching.flatMap((w) => w.networks));

  return (
    <>
      {err && <div className={s.err}>{err}</div>}

      <div className={s.watchBar}>
        <span className={`${s.badge} ${cfg.mode === 'off' ? s.expired : cfg.mode === 'auto' ? s.approved : s.pending}`}>
          {MODE_RU[cfg.mode].name}
        </span>
        {cfg.mode === 'off' ? (
          <span className={s.dim}>бот не слушает сеть — переводы придётся сверять руками</span>
        ) : (
          <span className={s.dim}>
            бот слушает <b>{watching.length}</b> адрес. · <b>{liveNets.size}</b> сет. ·
            {' '}{cfg.tokens.map((t) => t.toUpperCase()).join(', ') || '— монет нет'}
          </span>
        )}
        <button type="button" className={s.refresh} onClick={() => void load()}>Обновить</button>
      </div>

      <h2 className={s.sect}>Режим бота</h2>
      <p className={s.dim} style={{ marginBottom: 10 }}>
        Начинать стоит с наблюдения: день смотришь в логи, что бот <i>сопоставил бы</i>,
        и только потом даёшь ему трогать деньги.
      </p>
      <div className={s.modes}>
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            className={`${s.mode} ${cfg.mode === m ? s.on : ''}`}
            disabled={busy}
            onClick={() => void save({ mode: m })}
          >
            <span className={s.modeName}>{MODE_RU[m].name}</span>
            <span className={s.modeNote}>{MODE_RU[m].note}</span>
          </button>
        ))}
      </div>

      {cfg.mode === 'auto' && (
        <div className={s.warn}>
          В этом режиме баланс начисляется без человека. Держи его включённым,
          только если в «полуавтомате» сопоставление уже отработало без осечек.
        </div>
      )}

      <h2 className={s.sect}>Монеты</h2>
      <div className={s.pills}>
        {cat.tokens.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`${s.pill} ${cfg.tokens.includes(t.id) ? s.on : ''}`}
            disabled={busy}
            onClick={() => toggleToken(t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>

      <h2 className={s.sect}>Сети</h2>
      <p className={s.dim} style={{ marginBottom: 10 }}>
        Игрок видит только включённые. Комиссию платит он сам — по ней и выбирает.
      </p>
      <div className={s.netGrid}>
        {cat.networks.map((n) => {
          const on = cfg.networks.includes(n.id);
          const bad = broken(n);
          return (
            <button
              key={n.id}
              type="button"
              className={`${s.netCard} ${on ? s.on : ''} ${bad ? s.bad : ''}`}
              disabled={busy}
              onClick={() => toggleNet(n.id)}
            >
              <span className={s.netTop}>
                <span className={s.netName}>{n.name}</span>
                <span className={s.netFee}>{fee(n.feeUsd)}</span>
              </span>
              <span className={s.netSub}>
                {FAMILY_RU[n.family]} · {n.tokens.map((t) => t.toUpperCase()).join(', ')}
                {n.memo && ' · memo'}
              </span>
              {bad
                ? <span className={s.netBad}>{bad}</span>
                : on && <span className={s.netOk}>{liveNets.has(n.id) ? 'слушается' : 'открыта игрокам'}</span>}
            </button>
          );
        })}
      </div>

      <h2 className={s.sect}>Адреса приёма</h2>
      <p className={s.dim} style={{ marginBottom: 12 }}>
        Адрес заводится на <b>семейство</b>, а не на сеть: одна <code>0x…</code> принимает
        во всех EVM-сетях сразу. Добавленный адрес попадает в работу с ближайшего
        цикла наблюдателя — перезапускать ничего не надо.
      </p>

      {FAMILIES.map((f) => {
        const rows = addresses.filter((a) => a.family === f);
        const nets = netsOf(f);
        const open = adding === f;
        return (
          <div key={f} className={s.famBlock}>
            <div className={s.famHead}>
              <span className={s.famName}>{FAMILY_RU[f]}</span>
              <span className={s.famNets}>
                {nets.length
                  ? nets.map((n) => n.name).join(' · ')
                  : <span className={s.dim}>ни одна сеть не включена</span>}
              </span>
              <button
                type="button"
                className={s.btnSm}
                onClick={() => { setAdding(open ? null : f); setAddress(''); setLabel(''); }}
              >
                {open ? 'Отмена' : 'Добавить адрес'}
              </button>
            </div>

            {open && (
              <div className={s.addrForm}>
                <input
                  className={s.input}
                  placeholder={HINT[f]}
                  value={address}
                  autoFocus
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addAddress(f); }}
                />
                <input
                  className={`${s.input} ${s.short}`}
                  placeholder="Заголовок (необяз.)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addAddress(f); }}
                />
                <button
                  type="button"
                  className={s.confirm}
                  disabled={busy || !address.trim()}
                  onClick={() => void addAddress(f)}
                >
                  {busy ? '…' : 'Добавить'}
                </button>
              </div>
            )}

            {rows.length === 0 ? (
              <div className={s.famEmpty}>
                {nets.length
                  ? 'Сети включены, но принимать некуда — заведи адрес'
                  : 'Адресов нет'}
              </div>
            ) : (
              <div className={s.addrList}>
                {rows.map((a) => {
                  const w = watching.find((x) => x.addressId === a.id);
                  return (
                    <div key={a.id} className={`${s.addrRow} ${a.active ? '' : s.off}`}>
                      <div className={s.addrMain}>
                        <div className={`${s.mono} ${s.wrapAny}`}>{a.address}</div>
                        <div className={s.addrMeta}>
                          {a.label && <span>{a.label}</span>}
                          <span>{a.pending > 0 ? `${a.pending} активн. заявок` : 'заявок нет'}</span>
                          <span>заведён {when(a.createdAt)}</span>
                          {a.scannedAt && <span>просмотрен {when(a.scannedAt)}</span>}
                        </div>
                      </div>
                      <div className={s.addrSide}>
                        <span className={`${s.badge} ${w ? s.approved : a.active ? s.pending : s.expired}`}>
                          {w ? `слушается · ${w.networks.length} сет.` : a.active ? 'не слушается' : 'выключен'}
                        </span>
                        <div className={s.rowActions}>
                          <button type="button" className={s.btnSm} disabled={addrBusy.has(a.id)}
                            onClick={() => void toggleAddr(a)}>
                            {a.active ? 'Выкл' : 'Вкл'}
                          </button>
                          <button type="button" className={s.btnSm} onClick={() => void renameAddr(a)}>
                            Заголовок
                          </button>
                          <button type="button" className={`${s.btnSm} ${s.no}`} onClick={() => void removeAddr(a)}>
                            Удалить
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {ask.dialog}
    </>
  );
}
