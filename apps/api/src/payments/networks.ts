/* ============================================================
   МЕРЕЖІ Й ТОКЕНИ ПРИЙОМУ.

   Одне місце, де описано все, що відрізняє одну мережу від іншої.
   Спостерігач за переказами (з'явиться, коли будуть ключі) читатиме
   саме звідси, тож додати мережу = дописати рядок, а не правити код.

   РОДИНА, А НЕ МЕРЕЖА, Є ОДИНИЦЕЮ РЕАЛІЗАЦІЇ. У EVM однаковий формат
   адреси й однакова подія переказу, тому один спостерігач покриває
   шість мереж. Через це й адреси прийому заводяться на РОДИНУ: та сама
   0x-адреса приймає гроші в Polygon, Base, Arbitrum, Optimism, BSC і
   Avalanche одночасно.

   Побічна користь: гравець, який переплутав мережу при відправці,
   більше не втрачає гроші — ми слухаємо всі шість, і переказ
   знайдеться, у якій би з них не прийшов.
   ============================================================ */

/* Ідентифікатори мереж і монет живуть у @minedrop/contracts: їх однаково
   мусять знати сервер, гра й CRM, і три копії одного union-а вже
   розходились. Тут лише перевипуск, щоб решта серверного коду й далі
   імпортувала їх звідси — з каталогу мереж, де їм за змістом і місце. */
export type { Family, NetworkId, TokenId } from '@minedrop/contracts';
import type { Family, NetworkId, TokenId } from '@minedrop/contracts';

export interface TokenOnNetwork {
  /* Адреса контракту токена в цій мережі.

     ЗВІРИТИ З ОФІЦІЙНИМ ДЖЕРЕЛОМ ПЕРЕД УВІМКНЕННЯМ МЕРЕЖІ. Помилка тут
     не крадіжка, а сліпота: спостерігач просто не побачить переказів і
     жодного депозиту не зарахує. Це помітно одразу, але краще не
     витрачати на це день. */
  contract: string;
  /* Скільки знаків після коми ОЧІКУЄМО.

     Це не константа для розрахунку, а ЗАПОБІЖНИК. Реальні знаки
     спостерігач бере з відповіді API і звіряє з цим числом; не
     збіглось — переказ не зараховується, а йде адміну. Помилка на
     порядок тут означала б зарахування в мільйон разів більше.

     Майже всюди 6. Виняток — BSC, там в обох токенів 18. */
  decimals: number;
}

export interface NetworkDef {
  id: NetworkId;
  /** як показуємо гравцю */
  name: string;
  family: Family;
  /** приблизна комісія ВІДПРАВНИКА, USD — показуємо у виборі мережі */
  feeUsd: number;
  /** скільки секунд переказ має «відлежатись», перш ніж вважати остаточним */
  finalitySec: number;
  /* Переказ ідентифікується коментарем (memo), а не сумою.

     Це надійніше: у TON гравець вставляє короткий код у поле коментаря,
     і зіставлення точне. Де memo немає (TRON, EVM, Solana), доводиться
     розводити заявки унікальним дробом суми. */
  memo?: boolean;
  tokens: Partial<Record<TokenId, TokenOnNetwork>>;
}

export const TOKENS: Record<TokenId, { name: string; icon: string }> = {
  usdt: { name: 'USDT', icon: '/coins/usdt.png' },
  usdc: { name: 'USDC', icon: '/coins/usdc.png' },
};

/* Ethereum свідомо відсутній: комісія $2-20 на депозиті в кілька сотень
   гривень робить його непридатним. Знадобиться — додається рядком. */
export const NETWORKS: Record<NetworkId, NetworkDef> = {
  ton: {
    id: 'ton', name: 'TON', family: 'ton', feeUsd: 0.01, finalitySec: 20,
    memo: true,
    tokens: {
      usdt: { contract: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', decimals: 6 },
    },
  },
  tron: {
    id: 'tron', name: 'TRON (TRC20)', family: 'tron', feeUsd: 5, finalitySec: 90,
    tokens: {
      usdt: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
      usdc: { contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', decimals: 6 },
    },
  },
  solana: {
    id: 'solana', name: 'Solana', family: 'solana', feeUsd: 0.01, finalitySec: 30,
    tokens: {
      usdt: { contract: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
      usdc: { contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    },
  },
  bsc: {
    id: 'bsc', name: 'BNB Chain (BEP20)', family: 'evm', feeUsd: 0.15, finalitySec: 45,
    tokens: {
      // ЄДИНА мережа, де в обох токенів 18 знаків, а не 6
      usdt: { contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      usdc: { contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    },
  },
  polygon: {
    id: 'polygon', name: 'Polygon', family: 'evm', feeUsd: 0.01, finalitySec: 90,
    tokens: {
      usdt: { contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
      usdc: { contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    },
  },
  base: {
    id: 'base', name: 'Base', family: 'evm', feeUsd: 0.01, finalitySec: 60,
    tokens: {
      usdc: { contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    },
  },
  arbitrum: {
    id: 'arbitrum', name: 'Arbitrum', family: 'evm', feeUsd: 0.02, finalitySec: 60,
    tokens: {
      usdt: { contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
      usdc: { contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    },
  },
  optimism: {
    id: 'optimism', name: 'Optimism', family: 'evm', feeUsd: 0.02, finalitySec: 60,
    tokens: {
      usdt: { contract: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
      usdc: { contract: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    },
  },
  avalanche: {
    id: 'avalanche', name: 'Avalanche', family: 'evm', feeUsd: 0.05, finalitySec: 30,
    tokens: {
      usdt: { contract: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
      usdc: { contract: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
    },
  },
};

/* Формат адреси на кожну родину. Перевірка м'яка — відсіює друкарську
   помилку й вставлений не той рядок, а не рахує контрольну суму. */
const ADDRESS_RE: Record<Family, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ton: /^(?:[EU]Q[A-Za-z0-9_-]{46}|0:[0-9a-fA-F]{64})$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};

export const isValidAddress = (family: Family, address: string): boolean =>
  ADDRESS_RE[family].test(address.trim());

export const FAMILY_HINT: Record<Family, string> = {
  evm: '0x… — одна адреса приймає в Polygon, Base, Arbitrum, Optimism, BNB Chain і Avalanche',
  tron: 'T… — 34 символи',
  ton: 'EQ… / UQ…',
  solana: 'base58, 32-44 символи',
};

export const networkList = (): NetworkDef[] => Object.values(NETWORKS);

/** Мережі, у яких цей токен узагалі існує. */
export const networksForToken = (token: TokenId): NetworkDef[] =>
  networkList().filter((n) => !!n.tokens[token]);

/* Знайти монету за адресою контракту.

   Саме цим спостерігач відрізняє наш переказ від чужого: на нашу
   адресу може прийти будь-який токен, включно зі скам-монетами, які
   розсилають пачками. Контракт немає в каталозі — це не наші гроші. */
export const tokenByContract = (
  network: NetworkId,
  contract: string,
): { id: TokenId; def: TokenOnNetwork } | undefined => {
  const net = NETWORKS[network];
  if (!net) return undefined;
  const want = contract.trim().toLowerCase();
  for (const [id, def] of Object.entries(net.tokens)) {
    if (def && def.contract.toLowerCase() === want) {
      return { id: id as TokenId, def };
    }
  }
  return undefined;
};

export const isNetwork = (v: string): v is NetworkId => v in NETWORKS;
export const isToken = (v: string): v is TokenId => v in TOKENS;
