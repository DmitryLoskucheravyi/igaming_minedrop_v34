/* ============================================================
   SOLANA — Helius.

   Enhanced Transactions віддає вже РОЗІБРАНІ перекази: у кожному
   tokenTransfers із власником-отримувачем (toUserAccount), монетою
   (mint) і сумою. Це важливо: у Solana токен фізично лежить не на
   гаманці, а на окремому токен-акаунті, і без розбору довелося б
   спершу шукати ці акаунти, а потім читати кожну транзакцію окремо.

   Historія віддається від НОВІШИХ до старіших, а курсор (`until`) —
   це підпис, на якому зупинитись. Тому сторінки збираємо назад у часі,
   а потім розвертаємо.
   ============================================================ */

import { NETWORKS, tokenByContract } from '../../payments/networks';
import type { NetworkId } from '../../payments/networks';
import type { IncomingTx } from '../../payments/payments.service';
import {
  httpJson, rpc,
  type ChainReader, type ScanContext, type ScanResult, type Verdict,
} from '../chain.types';

const API = 'https://api.helius.xyz/v0';
const RPC_URL = (key: string) => `https://mainnet.helius-rpc.com/?api-key=${key}`;
const PAGE = 100;
const MAX_PAGES = 5;

interface HeliusTransfer {
  toUserAccount?: string;
  fromUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
}

interface HeliusBalanceChange {
  userAccount?: string;
  mint?: string;
  rawTokenAmount?: { tokenAmount?: string; decimals?: number };
}

interface HeliusTx {
  signature: string;
  timestamp: number;            // секунди
  transactionError?: unknown;
  tokenTransfers?: HeliusTransfer[];
  accountData?: { tokenBalanceChanges?: HeliusBalanceChange[] }[];
}

export const solanaReader: ChainReader = {
  family: 'solana',
  provider: 'Helius',

  async scan(ctx: ScanContext): Promise<ScanResult> {
    if (!ctx.networks.includes('solana')) return { txs: [] };

    const base = `${API}/addresses/${encodeURIComponent(ctx.address)}/transactions` +
      `?api-key=${encodeURIComponent(ctx.key)}&limit=${PAGE}` +
      (ctx.cursor ? `&until=${encodeURIComponent(ctx.cursor)}` : '');

    const pages: HeliusTx[] = [];
    let before: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await httpJson<HeliusTx[]>(
        base + (before ? `&before=${encodeURIComponent(before)}` : ''), {}, 25_000);
      if (!Array.isArray(rows) || !rows.length) break;
      pages.push(...rows);
      if (rows.length < PAGE) break;
      before = rows[rows.length - 1]?.signature;
      if (!before) break;
    }

    /* Найновіший підпис — і є курсор наступного циклу. Береться до
       фільтрації: серед пропущених транзакцій наших переказів немає,
       але повертатись до них щоразу теж не треба. */
    const newest = pages.length ? pages[0].signature : ctx.cursor;

    const txs: IncomingTx[] = [];
    for (const t of pages) {
      if (t.transactionError) continue;                 // транзакція впала
      if ((t.timestamp ?? 0) * 1000 < ctx.since) continue;
      for (const tr of t.tokenTransfers ?? []) {
        const tx = toIncoming(tr, t, ctx.address, ctx.tokens);
        if (tx) txs.push(tx);
      }
    }

    txs.sort((a, b) => a.at - b.at);
    return { txs, cursor: newest };
  },

  /* Питаємо ФІНАЛІЗОВАНИЙ стан: підтверджений, але ще не фіналізований
     слот теоретично може відпасти, а нам тут потрібна саме остаточність. */
  async confirm(key: string, _network: NetworkId, txid: string): Promise<Verdict> {
    void _network;
    try {
      const body = await rpc<{ meta?: { err?: unknown } } | null>(
        RPC_URL(key), 'getTransaction',
        [txid, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      if (body.error) return 'unknown';
      if (body.result === null) return 'gone';
      if (!body.result) return 'unknown';
      return body.result.meta?.err ? 'gone' : 'ok';
    } catch {
      return 'unknown';
    }
  },
};

function toIncoming(
  tr: HeliusTransfer,
  t: HeliusTx,
  address: string,
  tokens: readonly string[],
): IncomingTx | undefined {
  if (tr.toUserAccount !== address) return undefined;

  const found = tokenByContract('solana', tr.mint ?? '');
  if (!found || !tokens.includes(found.id)) return undefined;

  /* tokenAmount Helius уже поділив на знаки після коми, тож звірити їх
     напряму ніяк. Але поруч, у tokenBalanceChanges, лежить сира сума
     разом зі знаками — саме її й беремо за джерело правди. Немає й
     її — віримо розібраній сумі, іншої в нас немає. */
  const raw = (t.accountData ?? [])
    .flatMap((a) => a.tokenBalanceChanges ?? [])
    .find((c) => c.userAccount === address && c.mint === tr.mint);
  const decimals = raw?.rawTokenAmount?.decimals;

  const suspect = decimals !== undefined && decimals !== found.def.decimals
    ? `в сети ${NETWORKS.solana.name} у ${found.id.toUpperCase()} ${decimals} знаков ` +
      `вместо ${found.def.decimals} — сумме верить нельзя`
    : undefined;

  return {
    network: 'solana',
    token: found.id,
    to: address,
    from: tr.fromUserAccount ?? '—',
    amount: tr.tokenAmount ?? 0,
    txid: t.signature,
    at: (t.timestamp ?? 0) * 1000,
    suspect,
  };
}
