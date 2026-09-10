/* ============================================================
   EVM — Ankr Advanced API.

   Один запит `ankr_getTokenTransfers` віддає перекази одразу по всіх
   шести мережах: у параметрі blockchain список, у кожному переказі
   поле blockchain. Тобто гравець, який переплутав Polygon із Base,
   грошей не втрачає — ми й так дивимось обидві.

   Курсор — час останнього побаченого переказу в СЕКУНДАХ (так його
   хоче fromTimestamp). Не nextPageToken: той живе всередині однієї
   вибірки й наступного циклу вже не годиться.
   ============================================================ */

import { NETWORKS, tokenByContract, type NetworkId } from '../../payments/networks';
import type { IncomingTx } from '../../payments/payment.types';
import {
  fromRaw, rpc,
  type ChainReader, type ScanContext, type ScanResult, type Verdict,
} from '../chain.types';

/** Як мережа зветься в Ankr. Кого тут немає — той через Ankr не читається. */
const ANKR_CHAIN: Partial<Record<NetworkId, string>> = {
  bsc: 'bsc',
  polygon: 'polygon',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  avalanche: 'avalanche',
};

const BY_ANKR = new Map(
  Object.entries(ANKR_CHAIN).map(([id, name]) => [name, id as NetworkId]),
);

const MULTICHAIN = (key: string) => `https://rpc.ankr.com/multichain/${key}`;
const RPC = (key: string, chain: string) => `https://rpc.ankr.com/${chain}/${key}`;

interface AnkrTransfer {
  fromAddress: string;
  toAddress: string;
  contractAddress: string;
  valueRawInteger: string;
  tokenDecimals: number;
  blockchain: string;
  transactionHash: string;
  timestamp: number;          // секунди
  direction?: string;
}

interface AnkrPage {
  transfers?: AnkrTransfer[];
  nextPageToken?: string;
}

/* Скільки сторінок беремо за цикл. Перший обхід свіжої адреси може
   впертись у довгу історію; далі сторінка завжди одна. Обрив на
   ліміті не втрачає нічого: курсор посунувся, решта прийде наступним
   циклом через двадцять секунд. */
const MAX_PAGES = 5;
const PAGE_SIZE = 100;

export const evmReader: ChainReader = {
  family: 'evm',
  provider: 'Ankr',

  async scan(ctx: ScanContext): Promise<ScanResult> {
    const chains = ctx.networks.map((n) => ANKR_CHAIN[n]).filter((c): c is string => !!c);
    if (!chains.length) return { txs: [] };

    /* Секунда назад від курсора: межа fromTimestamp включна, і переказ,
       що прийшов у ту саму секунду, що й останній оброблений, інакше
       випав би назавжди. Повтор нам не страшний — knownTxid відсіє. */
    const fromSec = Math.max(0, Math.floor(cursorMs(ctx) / 1000) - 1);

    const txs: IncomingTx[] = [];
    let pageToken: string | undefined;
    let newestSec = Math.floor(cursorMs(ctx) / 1000);

    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await rpc<AnkrPage>(MULTICHAIN(ctx.key), 'ankr_getTokenTransfers', {
        blockchain: chains,
        address: [ctx.address],
        fromTimestamp: fromSec,
        pageSize: PAGE_SIZE,
        descOrder: false,
        ...(pageToken ? { pageToken } : {}),
      });
      if (body.error) throw new Error(body.error.message ?? 'ankr error');

      const rows = body.result?.transfers ?? [];
      for (const t of rows) {
        newestSec = Math.max(newestSec, t.timestamp);
        const tx = toIncoming(t, ctx.address, ctx.tokens);
        if (tx) txs.push(tx);
      }

      pageToken = body.result?.nextPageToken || undefined;
      if (!pageToken || rows.length < PAGE_SIZE) break;
    }

    txs.sort((a, b) => a.at - b.at);
    return { txs, cursor: String(newestSec * 1000) };
  },

  /* Розрахунок у мережі: квитанція є і статус успішний -> переказ на
     місці. Квитанції немає зовсім -> транзакцію відкотили. */
  async confirm(key: string, network: NetworkId, txid: string): Promise<Verdict> {
    const chain = ANKR_CHAIN[network];
    if (!chain) return 'unknown';
    try {
      const body = await rpc<{ status?: string; blockNumber?: string } | null>(
        RPC(key, chain), 'eth_getTransactionReceipt', [txid]);
      if (body.error) return 'unknown';
      const r = body.result;
      if (r === null) return 'gone';
      if (!r) return 'unknown';
      return r.status === '0x0' ? 'gone' : 'ok';
    } catch {
      return 'unknown';
    }
  },
};

const cursorMs = (ctx: ScanContext): number =>
  Math.max(ctx.since, Number(ctx.cursor) || 0);

/* Переказ Ankr -> наш IncomingTx. undefined = не наші гроші:
   чужий отримувач, вихідний переказ або невідомий контракт (на адресу
   регулярно сиплеться скам, і кожну таку монету адміну показувати не
   треба). */
function toIncoming(
  t: AnkrTransfer,
  address: string,
  tokens: readonly string[],
): IncomingTx | undefined {
  const network = BY_ANKR.get(t.blockchain);
  if (!network) return undefined;
  if (t.toAddress?.toLowerCase() !== address.toLowerCase()) return undefined;

  const found = tokenByContract(network, t.contractAddress ?? '');
  if (!found || !tokens.includes(found.id)) return undefined;

  /* Знаки після коми з відповіді звіряємо з каталогом. Розбіжність —
     не привід мовчки поділити на те, що дали: помилка на порядок тут
     означала б зарахування в тисячі разів більше. Переказ іде адміну
     з поясненням (див. IncomingTx.suspect). */
  const suspect = t.tokenDecimals !== found.def.decimals
    ? `в сети ${NETWORKS[network].name} у ${found.id.toUpperCase()} ` +
      `${t.tokenDecimals} знаков вместо ${found.def.decimals} — сумме верить нельзя`
    : undefined;

  return {
    network,
    token: found.id,
    to: t.toAddress,
    from: t.fromAddress,
    amount: fromRaw(t.valueRawInteger ?? '0', t.tokenDecimals ?? found.def.decimals),
    txid: t.transactionHash,
    at: t.timestamp * 1000,
    suspect,
  };
}
