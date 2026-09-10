/* ============================================================
   TYPES — спільний словник сервера і клієнта.
   Все, що їздить по HTTP, описано тут.
   ============================================================ */

/* УВАГА: 'gold' у BlockId нижче — це РУДА ЗОЛОТА, а не кірка. Золотої
   КІРКИ в грі немає: тірів чотири. */
export type TierId = 'lvl2' | 'lvl3' | 'lvl4' | 'diamond';
export type BlockId =
  | 'grass' | 'dirt' | 'stone' | 'coal' | 'redstone' | 'iron' | 'lapis' | 'gold' | 'diamond' | 'emerald'
  | 'tnt' | 'magic' | 'mult' | 'grow' | 'rubber' | 'scatter';
/* 'magic' у BlockId — це ВЕРСТАК (kind 'upgrade'), а не зачарування:
   ім'я історичне, див. коментар до BLOCKS у config.ts. Kind 'magic'
   (стіл зачарування) прибрано разом із самою механікою. */
export type BlockKind =
  | 'solid' | 'tnt' | 'mult' | 'upgrade' | 'grow' | 'rubber' | 'scatter';

export interface Tier {
  id: TierId;
  name: string;
  weight: number;   // вага на рулетці
  hp: number;       // запас міцності
  dmg: number;      // урон за удар
  color: string;
  color2: string;
  skin: string;
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
  /* healOnly=false -> підвищення тіру. healOnly=true, topUp=0 -> повний
     хіл (1-й верстак на топ-тірі). topUp>0 -> дохіл на topUp HP. */
  | { t: 'upgrade'; r: number; c: number; tier: TierId; healOnly: boolean; topUp: number; pick: number }
  /* m — номінал блоку (x2, x5...), active — множник вікна після цього блоку,
     secs — на скільки секунд відкрито/подовжено вікно множення */
  | { t: 'mult'; r: number; c: number; m: number; active: number; secs: number; pick: number }
  /* стрілка вгору: кірка тимчасово більшає. scale — сумарний розмір
     після цього блоку (збільшення стакаються), stacks — скільки їх
     активно, secs — на скільки секунд додалось саме це */
  | { t: 'grow'; r: number; c: number; scale: number; stacks: number; secs: number; pick: number }
  /* гумовий блок: посилений відскок + прискорене падіння на secs секунд */
  | { t: 'rubber'; r: number; c: number; secs: number; pick: number }
  /* скаттер: n — скільки зібрано разом із цим, need — скільки треба на
     бонуску. n === need — саме цей блок її і відкрив */
  | { t: 'scatter'; r: number; c: number; n: number; need: number; pick: number }
  | { t: 'pickdead'; x: number; y: number; tier: TierId; pick: number }
  | { t: 'end'; reason: RunEndReason };

export type RunEndReason = 'broken' | 'timeout' | 'limit';

/* Режим раунду.
     bet — звичайна ставка: крутиться рулетка, кірка може й не випасти.
     buy — «бонус бай»: гравець платить більше і ГАРАНТОВАНО отримує
           обрану кірку, а шахта генерується з підвищеним спавном
           множників і столів зачарування (CONFIG.buy). */
export type RoundMode = 'bet' | 'buy';

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
  /* Скільки скаттерів зібрано за забіг. Частина підсумку, а не окреме
     поле збоку: клієнт мусить відтворити це число з того самого сида,
     інакше він показав би бонуску там, де сервер її не дав. */
  scatters: number;
  timeSec: number;
  steps: number;
  reason: RunEndReason;
}

export interface RoundResult {
  roundId: string;
  mode: RoundMode;
  bet: number;
  cost: number;              // скільки списано (ставка або ціна бонуски)
  /** яку кірку куплено (тільки для mode 'buy') */
  buy?: TierId;
  /* Бонуска, виграна скаттерами, а не куплена: cost 0, кірка випадкова.
     Шахта та сама, що в купленої (bonus: true). */
  free?: boolean;
  /* У ЦЬОМУ раунді зібрано скаттери — наступний буде безкоштовною
     бонускою. Клієнт малює по цьому плашку. */
  bonusWon?: boolean;

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
  /* Невитрачена бонуска, виграна скаттерами: наступна ставка буде нею,
     безкоштовно і на ЦІЙ ставці (гравець не може перенести її на дорожчу
     — інакше скаттери на 10 монетах перетворювались би на бонуску за
     5000). null — виграної бонуски немає. */
  pendingBonus: { bet: number } | null;
  dryStreak: number;         // пустих ставок поспіль (для показу pity-прогресу)
  nonce: number;
  clientSeed: string;
  serverSeedHash: string;
}
