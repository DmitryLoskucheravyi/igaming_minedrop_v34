/* ============================================================
   TYPES — спільний словник сервера і клієнта.
   Все, що їздить по HTTP, описано тут.
   ============================================================ */

export type TierId = 'lvl2' | 'lvl3' | 'lvl4' | 'gold' | 'diamond';
export type BlockId =
  | 'grass' | 'dirt' | 'stone' | 'coal' | 'redstone' | 'iron' | 'lapis' | 'gold' | 'diamond' | 'emerald'
  | 'tnt' | 'magic' | 'enchant' | 'mult';
export type BlockKind = 'solid' | 'tnt' | 'magic' | 'mult' | 'upgrade';

export interface Tier {
  id: TierId;
  name: string;
  weight: number;   // вага на рулетці
  hp: number;       // запас міцності
  dmg: number;      // урон за удар
  color: string;
  color2: string;
  skin: string;
  skinMagic: string;
}

export interface BlockDef {
  id: BlockId;
  name: string;
  kind: BlockKind;
  tough: number;    // міцність: скільки урону треба, щоб розколоти
  cost: number;     // скільки HP кірки з'їдає один удар
  value: number;    // скільки очок дає розколотий блок
  color: string;
  skin?: string;
}

/* Результат одного прокруту рулетки. null = «пусто» (Х). */
export type SpinResult = TierId | null;

/* Подія фізики. Клієнт вішає на них партикли, тряску і звук. */
export type RunEvent =
  | { t: 'break'; r: number; c: number; id: BlockId; got: number; pick: number }
  | { t: 'crack'; r: number; c: number; id: BlockId; stage: number; of: number; pick: number }
  | { t: 'tnt'; r: number; c: number; hit: { r: number; c: number; id: BlockId }[]; got: number; chain: number; pick: number }
  | { t: 'tntchain'; r: number; c: number; chain: number; mult: number; extra: number; pick: number }
  | { t: 'magic'; r: number; c: number; mult: number; lvl: number; pick: number }
  | { t: 'upgrade'; r: number; c: number; tier: TierId; healOnly: boolean; pick: number }
  /* m — номінал блоку (x2, x5...), active — множник вікна після цього блоку,
     secs — на скільки секунд відкрито/подовжено вікно множення */
  | { t: 'mult'; r: number; c: number; m: number; active: number; secs: number; pick: number }
  | { t: 'pickdead'; x: number; y: number; tier: TierId; pick: number }
  | { t: 'end'; reason: RunEndReason };

export type RunEndReason = 'broken' | 'timeout' | 'limit';

/* Режим раунду. Бонуску прибрано — лишилась лише звичайна ставка.
   Тип збережено (а не видалено) як точку розширення на майбутнє. */
export type RoundMode = 'bet';

/* Підсумок симуляції — те, що сервер порахував і що клієнт мусить
   відтворити з того самого сида. */
export interface RunSummary {
  collected: number;    // сирі очки до ділення на payoutK
  multChain: number;    // найбільший активний множник вікна за забіг
  blocks: number;
  hits: number;
  depth: number;
  mults: number;
  tnts: number;
  upgrades: number;
  timeSec: number;
  steps: number;
  reason: RunEndReason;
}

export interface RoundResult {
  roundId: string;
  mode: RoundMode;
  bet: number;
  cost: number;              // скільки списано (= ставка)

  seed: string;              // сид раунду — з нього клієнт переграє все
  spins: SpinResult[];       // що випало на кожному прокруті
  tiers: TierId[];           // кірки, які пішли в шахту
  startCols: number[];       // з яких колонок стартують кірки
  pity: boolean;             // прокрут форсований (гарантована кірка після серії пустих)
  dryStreak: number;         // скільки пустих ставок поспіль ПІСЛЯ цього раунду (0 після кірки)

  sim: RunSummary;

  rawPayout: number;         // виплата без стелі
  payout: number;            // фактична виплата
  capped: boolean;           // стеля спрацювала
  multiplier: number;        // payout / cost

  balanceBefore: number;
  balanceAfter: number;

  fair: {
    serverSeedHash: string;
    clientSeed: string;
    nonce: number;
  };
}

export interface PlayerState {
  playerId: string;
  balance: number;
  dryStreak: number;         // пустих ставок поспіль (для показу pity-прогресу)
  nonce: number;
  clientSeed: string;
  serverSeedHash: string;
}
