/* ============================================================
   TRON — TronGrid.

   У TRON немає коментаря до переказу, тож заявку ідентифікує дріб
   суми (див. PaymentsService). Читачу від цього ні тепло ні холодно:
   він просто віддає всі вхідні TRC20 на нашу адресу.

   only_confirmed=true — беремо лише те, що вже в підтвердженому блоці.
   Курсор — block_timestamp останнього побаченого переказу.
   ============================================================ */

import { NETWORKS, tokenByContract, type NetworkId } from '../../payments/networks';
import type { IncomingTx } from '../../payments/payments.service';
import {
  fromRaw, httpJson,
  type ChainReader, type ScanContext, type ScanResult, type Verdict,
} from '../chain.types';

const BASE = 'https://api.trongrid.io';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

interface TronTransfer {
  transaction_id: string;
  token_info?: { address?: string; decimals?: number; symbol?: string };
  block_timestamp: number;      // мс
  from: string;
  to: string;
  type?: string;
  value: string;
}

interface TronPage {
  data?: TronTransfer[];
  success?: boolean;
  meta?: { links?: { next?: string } };
}

const head = (key: string) => ({ 'TRON-PRO-API-KEY': key, accept: 'application/json' });

export const tronReader: ChainReader = {
  family: 'tron',
  provider: 'TronGrid',

  async scan(ctx: ScanContext): Promise<ScanResult> {
    if (!ctx.networks.includes('tron')) return { txs: [] };

    /* Мілісекунда назад: межа min_timestamp включна, і переказ, що
       прийшов у ту саму мілісекунду, що й останній оброблений, інакше
       випав би назавжди. Повтор відсіє knownTxid. */
    const since = Math.max(ctx.since, Number(ctx.cursor) || 0);
    let url =
      `${BASE}/v1/accounts/${encodeURIComponent(ctx.address)}/transactions/trc20` +
      `?only_confirmed=true&only_to=true&limit=${PAGE_SIZE}` +
      `&order_by=block_timestamp,asc&min_timestamp=${Math.max(0, since - 1)}`;

    const txs: IncomingTx[] = [];
    let newest = since;

    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await httpJson<TronPage>(url, { headers: head(ctx.key) });
      const rows = body.data ?? [];
      for (const t of rows) {
        newest = Math.max(newest, t.block_timestamp ?? 0);
        const tx = toIncoming(t, ctx.address, ctx.tokens);
        if (tx) txs.push(tx);
      }
      const next = body.meta?.links?.next;
      if (!next || rows.length < PAGE_SIZE) break;
      url = next;
    }

    txs.sort((a, b) => a.at - b.at);
    return { txs, cursor: String(newest) };
  },

  /* SUCCESS у квитанції — переказ на місці. Транзакції немає взагалі
     (порожня відповідь) — її відкотили. */
  async confirm(key: string, _network: NetworkId, txid: string): Promise<Verdict> {
    void _network;
    try {
      const body = await httpJson<{ id?: string; receipt?: { result?: string } }>(
        `${BASE}/wallet/gettransactioninfobyid`,
        {
          method: 'POST',
          headers: { ...head(key), 'content-type': 'application/json' },
          body: JSON.stringify({ value: txid }),
        });
      if (!body || !body.id) return 'gone';
      const r = body.receipt?.result;
      /* Порожній result у TRC20-переказі — норма (він не завжди
         проставлений), а от явний FAILED/REVERT — ні. */
      if (r && r !== 'SUCCESS') return 'gone';
      return 'ok';
    } catch {
      return 'unknown';
    }
  },
};

function toIncoming(
  t: TronTransfer,
  address: string,
  tokens: readonly string[],
): IncomingTx | undefined {
  if (t.type && t.type !== 'Transfer') return undefined;
  if (t.to !== address) return undefined;

  const found = tokenByContract('tron', t.token_info?.address ?? '');
  if (!found || !tokens.includes(found.id)) return undefined;

  const decimals = t.token_info?.decimals ?? found.def.decimals;
  const suspect = decimals !== found.def.decimals
    ? `в сети ${NETWORKS.tron.name} у ${found.id.toUpperCase()} ${decimals} знаков ` +
      `вместо ${found.def.decimals} — сумме верить нельзя`
    : undefined;

  return {
    network: 'tron',
    token: found.id,
    to: t.to,
    from: t.from,
    amount: fromRaw(t.value ?? '0', decimals),
    txid: t.transaction_id,
    at: t.block_timestamp,
    suspect,
  };
}
