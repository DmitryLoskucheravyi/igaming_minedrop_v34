/* ============================================================
   TON — tonapi.io.

   Єдина родина, де переказ ідентифікує КОМЕНТАР, а не дріб суми. Тому
   тут важливо не загубити поле comment: без нього заявку не впізнати
   (див. findCandidate у PaymentsService), і переказ піде адміну.

   Читаємо /events, а не історію конкретного джетона: один запит
   покриває і USDT, і все, що додадуть у каталог пізніше.

   Адреси в TON пишуть трьома способами — EQ…, UQ… і сирим 0:hex.
   Це ОДНА Й ТА САМА адреса, тому все зводимо до сирого вигляду, перш
   ніж порівнювати. Інакше гаманець, заведений як UQ…, не збігся б із
   тим, що віддає API, і жоден переказ не знайшовся б.
   ============================================================ */

import { NETWORKS } from '../../payments/networks';
import type { NetworkId, TokenId } from '../../payments/networks';
import type { IncomingTx } from '../../payments/payments.service';
import {
  fromRaw, httpJson,
  type ChainReader, type ScanContext, type ScanResult, type Verdict,
} from '../chain.types';

const BASE = 'https://tonapi.io/v2';
const PAGE = 100;

interface TonJettonTransfer {
  sender?: { address?: string };
  recipient?: { address?: string };
  amount?: string;
  comment?: string;
  jetton?: { address?: string; decimals?: number; symbol?: string };
}

interface TonEvent {
  event_id: string;
  timestamp: number;            // секунди
  /** логічний час — ним же й гортаємо назад (before_lt) */
  lt?: number;
  in_progress?: boolean;
  actions?: { type?: string; status?: string; JettonTransfer?: TonJettonTransfer }[];
}

/* Скільки сторінок беремо за цикл. Стелю треба тому, що перший обхід
   давно заведеної адреси може впертись у довгу історію; обрив на ній
   нічого не втрачає — курсор посунеться на оброблене, решта прийде
   наступним циклом. */
const MAX_PAGES = 5;

const head = (key: string) => ({ Authorization: `Bearer ${key}`, accept: 'application/json' });

export const tonReader: ChainReader = {
  family: 'ton',
  provider: 'TonAPI',

  async scan(ctx: ScanContext): Promise<ScanResult> {
    if (!ctx.networks.includes('ton')) return { txs: [] };

    const me = tonRaw(ctx.address);
    if (!me) throw new Error(`адреса ${ctx.address} не схожа на TON-адресу`);

    const sinceMs = Math.max(ctx.since, Number(ctx.cursor) || 0);
    const startDate = Math.max(0, Math.floor(sinceMs / 1000) - 1);

    /* TonAPI віддає НАЙНОВІШІ події, а не найстаріші від start_date.
       Тому гортаємо НАЗАД (before_lt), доки не впремося в межу, і лише
       потім рухаємо курсор уперед.

       Одну сторінку брати не можна: на адресі, куди за цикл прилетіло
       більше сотні подій, ми взяли б сто найновіших, посунули курсор і
       НАЗАВЖДИ втратили те, що лишилось під ними. Це були б чужі
       гроші, яких ми навіть не побачили. */
    const txs: IncomingTx[] = [];
    let newest = sinceMs;
    let beforeLt: number | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await httpJson<{ events?: TonEvent[] }>(
        `${BASE}/accounts/${encodeURIComponent(ctx.address)}/events` +
        `?limit=${PAGE}&start_date=${startDate}` +
        (beforeLt ? `&before_lt=${beforeLt}` : ''),
        { headers: head(ctx.key) });

      const events = body.events ?? [];
      for (const ev of events) {
        /* Подія ще не догралась: у TON переказ — це ланцюжок
           повідомлень, і поки він триває, сума й адресат ще можуть
           змінитись. Курсор теж не рухаємо, інакше цю подію ми більше
           не побачимо. */
        if (ev.in_progress) continue;
        newest = Math.max(newest, (ev.timestamp ?? 0) * 1000);

        for (const act of ev.actions ?? []) {
          if (act.type !== 'JettonTransfer' || act.status !== 'ok') continue;
          const tx = toIncoming(act.JettonTransfer, ev, me, ctx.tokens);
          if (tx) txs.push(tx);
        }
      }

      if (events.length < PAGE) break;
      const oldest = events[events.length - 1];
      if (!oldest?.lt) break;
      beforeLt = oldest.lt;
    }

    txs.sort((a, b) => a.at - b.at);
    return { txs, cursor: String(newest) };
  },

  async confirm(key: string, _network: NetworkId, txid: string): Promise<Verdict> {
    void _network;
    try {
      const ev = await httpJson<TonEvent>(
        `${BASE}/events/${encodeURIComponent(txid)}`, { headers: head(key) });
      if (!ev?.event_id) return 'gone';
      return ev.in_progress ? 'unknown' : 'ok';
    } catch (e) {
      // 404 — події немає, її відкотили; решта — ми просто не додзвонились
      return /HTTP 404/.test((e as Error).message) ? 'gone' : 'unknown';
    }
  },
};

function toIncoming(
  jt: TonJettonTransfer | undefined,
  ev: TonEvent,
  me: string,
  tokens: readonly string[],
): IncomingTx | undefined {
  if (!jt) return undefined;
  if (tonRaw(jt.recipient?.address ?? '') !== me) return undefined;

  /* Який це джетон. Порівнюємо в сирому вигляді: у каталозі контракт
     записаний як EQ…, а API віддає 0:hex — це та сама адреса. */
  const jetton = tonRaw(jt.jetton?.address ?? '');
  if (!jetton) return undefined;
  const found = Object.entries(NETWORKS.ton.tokens)
    .filter(([id]) => tokens.includes(id))
    .map(([id, def]) => ({ id: id as TokenId, def: def! }))
    .find((t) => tonRaw(t.def.contract) === jetton);
  if (!found) return undefined;

  const decimals = jt.jetton?.decimals ?? found.def.decimals;
  const suspect = decimals !== found.def.decimals
    ? `в сети TON у ${found.id.toUpperCase()} ${decimals} знаков вместо ` +
      `${found.def.decimals} — сумме верить нельзя`
    : undefined;

  return {
    network: 'ton',
    token: found.id,
    to: me,
    from: jt.sender?.address ?? '—',
    amount: fromRaw(jt.amount ?? '0', decimals),
    txid: ev.event_id,
    at: (ev.timestamp ?? 0) * 1000,
    memo: jt.comment?.trim() || undefined,
    suspect,
  };
}

/* EQ… / UQ… / 0:hex -> завжди 0:hex.

   Дружній вигляд — це 36 байт base64url: прапорець, робочий ланцюг,
   32 байти хеша й контрольна сума. Нам потрібні саме ланцюг і хеш;
   прапорець (E чи U — чи повертати переказ при помилці) на те, ЧИЯ це
   адреса, не впливає взагалі. */
export function tonRaw(addr: string): string | null {
  const a = addr.trim();
  if (!a) return null;
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(a)) {
    const [wc, hash] = a.split(':');
    return `${Number(wc)}:${hash.toLowerCase()}`;
  }
  if (!/^[A-Za-z0-9_+/-]{48}=*$/.test(a)) return null;
  try {
    const b = Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length !== 36) return null;
    return `${b.readInt8(1)}:${b.subarray(2, 34).toString('hex')}`;
  } catch {
    return null;
  }
}
