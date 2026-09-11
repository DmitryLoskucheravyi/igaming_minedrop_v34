import { BadRequestException, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { CONFIG, serverSeedHash } from '@minedrop/engine';
import type { RoundResult } from '@minedrop/engine';
import { MongoService } from '../db/mongo.service';
import { PlayerStore } from './player-store';
import type { TelegramUser } from '../telegram/init-data';
import { FS_PACK, spinsPrice } from '../spins/spins.types';
import { BONUS_DAYS, BONUS_MAX_BET_SHARE, BONUS_MAX_CASHOUT_X } from './bonus.types';
import { CONTRIBUTION, splitPayout, splitStake, type MoneySplit } from './money';

/* ============================================================
   PLAYERS — стан гравця живе на СЕРВЕРІ.

   Тут навмисно все, що впливає на гроші: баланс, стрік, nonce,
   виграна бонуска. Клієнт цих цифр не тримає — він їх лише показує.
   Якби стрік лічився в браузері, його можна було б накрутити з
   консолі й отримати бонуску за x70 безкоштовно.

   КЛЮЧ — TELEGRAM ID. Гравець більше не «той, хто прислав
   випадковий uuid із localStorage», а той, чий initData підписаний
   ботовим токеном. Відкрив мініапс з іншого пристрою — той самий
   баланс; підмінив id у запиті — підпис не зійдеться.

   СХОВИЩЕ: у процесі — Map, а копія лежить у MongoDB (PlayerStore).
   На старті все зчитується в Map; після кожної зміни, що торкає гроші
   (раунд, поповнення, ротація сида), документ гравця повністю
   перезаписується в БД (fire-and-forget, persist()). MONGO_URL порожній
   -> тільки Map, стан гине з рестартом (dev без БД).

   ГРОШІ ЗВІДКИ БЕРУТЬСЯ: новий гравець отримує CONFIG.startBalance
   (зараз 0) один раз, при заведенні. Далі баланс росте лише через
   депозит (заявка або ручне зарахування в CRM), подарунки колеса та
   реферальні виплати — тобто через місця, які пишуть у лог і мають
   свою ознаку «вже оплачено».

   Автоматичного «дотягування» балансу до стартового більше немає.
   Воно спрацьовувало на будь-якому зверненні гравця (навіть на
   GET /players/me і GET /payments/me) і робило платіжну частину
   непридатною до перевірки: щойно баланс падав нижче найдешевшої
   ставки, гроші з'являлись самі, ще до того, як гравець устигав
   створити заявку.
   ============================================================ */

export interface PlayerRecord {
  telegramId: number;
  username?: string;
  firstName: string;

  /* ДВА БАЛАНСИ — див. money.ts. cash виводиться, bonus спершу треба
     відіграти. Гравцю показується їхня сума; ділення видно лише там,
     де воно щось означає — у вікні виводу. */
  cash: number;
  bonus: number;
  /* Пустих прокрутів поспіль ОКРЕМО по кожній ставці: ключ — номінал
     ставки, значення — довжина серії на ній. Кірка (в т.ч. форсована)
     обнуляє лічильник СВОЄЇ ставки; промах — +1 до нього. Серія на
     ставці 10 не має жодного стосунку до серії на ставці 250, тож
     перемкнути гарантовану кірку на дорожчу ставку неможливо. */
  dryStreaks: Record<number, number>;

  /* Виграна скаттерами, ще не зіграна бонуска.

     Ставка зберігається РАЗОМ із нею і не підлягає зміні. Інакше
     з'являється проста схема: набити скаттери на ставці 10, а
     безкоштовну бонуску зіграти на 5000 — виплата ж рахується від
     ставки поточного раунду. Тому бонуска належить тій ставці, на якій
     її виграли.

     null — виграної бонуски немає. */
  pendingBonus: { bet: number } | null;

  /* РЕФЕРАЛЬНА ПРИВ'ЯЗКА.

     refBy — хто запросив. Ставиться РІВНО ОДИН РАЗ, у момент
     створення запису, і більше ніколи: інакше гравець переписував би
     її на друга щоразу, коли той хоче бонус.

     Дати виплат лежать тут само, а не в запрошувача, і це навмисно:
     подія належить запрошеному (він прийшов, він зробив депозит), а
     виплата — лише її наслідок. Так одна подія не може оплатитись
     двічі, навіть якщо запрошувача колись видалять і заведуть наново. */
  refBy: number | null;
  refJoinPaidAt: number | null;
  refDepositPaidAt: number | null;
  /* Скільки гравець УСЬОГО вніс депозитами, ₽. Потрібно лише для
     реферального порогу, тому рахується накопиченням тут, а не
     перебором заявок: заявки живуть в іншому сервісі, частина
     зарахувань приходить із неопізнаних переказів, і зшивати це на
     кожен запит означало б тримати дві різні відповіді на одне
     питання. */
  refDeposited: number;

  /* ВІДІГРАШ. wagerNeed — скільки обороту вимагає активний бонус,
     wagerDone — скільки вже зроблено В МЕЖАХ ЦЬОГО бонусу.

     Обидва живуть рівно стільки, скільки живе бонус: разом із ним
     вони й обнуляються (відіграв, програв або згорів). Це важливо —
     лічильник «за все життя» неможливо показати гравцю смужкою, бо
     незрозуміло, від чого рахувати початок.

     ВЛАСНИЙ ДЕПОЗИТ ВІДІГРАШУ НЕ ВИМАГАЄ. Колись тут стояла вимога x5
     на кожне поповнення, і це була помилка: відіграш вішають на БОНУС,
     а не на гроші гравця. Вимога до чистого депозиту — прихована
     комісія (оборот у 5 депозитів при віддачі 96% коштує ~20% від
     самого депозиту). Від фарму захищає бонусний баланс, а не це. */
  wagerNeed: number;
  wagerDone: number;

  /* Доки бонус живий. Не відіграв за цей час — бонусний баланс
     згорає разом із вимогою. Без терміну подарунок висів би вічно,
     роздуваючи видиме число й нічого не значачи. */
  bonusUntil: number;
  /* Стеля виводу з бонусу: скільки максимум можна перевести в готівку,
     коли відіграш завершиться. Рахується при нарахуванні як
     сума бонусу * BONUS_MAX_CASHOUT_X — на безкоштовні гроші стеля
     стоїть у будь-якому казино, інакше подарунок у 100 ₽ може
     обернутись виплатою в 50 000. */
  bonusCap: number;

  /* КУПЛЕНІ ФРІСПІНИ. buySpins — скільки лишилось, buySpinBet — ставка,
     за якою пакет куплений (вона ж і грається). Ставка зберігається
     разом із пакетом, а не береться поточна: інакше пакет, куплений на
     10, можна було б відіграти на 2000. */
  buySpins: number;
  buySpinBet: number;

  /* Накопичений виграш ПОТОЧНОЇ серії безкоштовних прокрутів.

     Гроші не падають на баланс після кожного прокруту, а збираються
     тут і зараховуються, коли серія добігла кінця — рівно так це
     влаштовано в казино, і з практичної причини: вимога відіграшу
     рахується від ПІДСУМКУ серії, а не від кожного прокруту окремо.
     Інакше двадцять дрібних виграшів дали б двадцять цілей. */
  freeSpinWin: number;

  /* КОЛЕСО ЩОДЕННОГО БОНУСУ.
     wheelAt — коли крутили востаннє; null (або 0) означає «жодного разу»,
     і саме за цим упізнається перший, гарантований прокрут.
     freeSpins — подаровані прокрути, які чекають своєї черги. Грають
     вони на фіксованій ставці (WHEEL_FREE_BET), а не на поточній —
     чому саме так, див. коментар до неї. */
  wheelAt: number | null;
  freeSpins: number;

  clientSeed: string;
  serverSeed: string;        // СЕКРЕТ. Ніколи не віддається до розкриття
  serverSeedHash: string;
  nonce: number;

  /** розкриті сиди минулих серій — гравець може перевірити старі раунди */
  revealed: { serverSeed: string; serverSeedHash: string; clientSeed: string; rounds: number }[];

  history: RoundResult[];
  createdAt: number;
  seenAt: number;
}

const HISTORY_LIMIT = 50;

@Injectable()
export class PlayersService implements OnModuleInit {
  private readonly log = new Logger(PlayersService.name);
  private readonly players = new Map<number, PlayerRecord>();
  private store: PlayerStore | null = null;

  constructor(private readonly mongo: MongoService) {}

  async onModuleInit(): Promise<void> {
    const db = await this.mongo.ready();
    if (!db) return;   // dev без БД — MongoService уже попередив у лог
    const store = new PlayerStore(db);
    const rows = await store.loadAll();
    for (const r of rows) this.players.set(r.telegramId, r);
    this.store = store;
    this.log.log(`Завантажено гравців із БД: ${rows.length}`);
  }

  /** Асинхронно скидає гравця в БД (fire-and-forget, помилку лише логуємо). */
  persist(rec: PlayerRecord): void {
    this.store?.save(rec).catch((e) =>
      this.log.error(`не зберігся гравець ${rec.telegramId}: ${(e as Error).message}`));
  }

  /** Перший вхід — заводимо гравця; далі просто знаходимо.
      Пише в БД лише коли справді щось змінилось (створення) — «останній
      вхід» без активності в БД не летить, це надто дрібно. Балансу тут
      не торкаємось: поповнення живе тільки в CRM. */
  /* Хто хоче знати про НОВОГО гравця. Спостерігач, а не прямий виклик,
     бо інакше цей сервіс мусив би знати про реферальну систему, а вона
     вже знає про нього — вийшло б кільце, яке Nest розв'яже хіба
     forwardRef. Тут же напрямок один: гроші за запрошення нараховує
     той, хто про них знає, а гравці лише повідомляють про появу. */
  private readonly created: ((rec: PlayerRecord) => void)[] = [];

  onCreated(fn: (rec: PlayerRecord) => void): void {
    this.created.push(fn);
  }

  /* startParam — стартовий параметр посилання з ПІДПИСАНОГО initData
     (див. TgStart). Потрапляє в запис лише при створенні: далі він уже
     ні на що не впливає. */
  findOrCreate(user: TelegramUser, startParam?: string): PlayerRecord {
    const found = this.players.get(user.id);
    if (found) {
      found.seenAt = Date.now();
      found.username = user.username ?? found.username;
      found.firstName = user.firstName || found.firstName;
      return found;
    }

    const serverSeed = randomBytes(32).toString('hex');
    const rec: PlayerRecord = {
      telegramId: user.id,
      username: user.username,
      firstName: user.firstName,
      cash: CONFIG.startBalance,
      bonus: 0,
      dryStreaks: {},
      pendingBonus: null,
      wheelAt: null,
      freeSpins: 0,
      refBy: null,
      refJoinPaidAt: null,
      refDepositPaidAt: null,
      refDeposited: 0,
      wagerNeed: 0,
      wagerDone: 0,
      bonusUntil: 0,
      bonusCap: 0,
      freeSpinWin: 0,
      buySpins: 0,
      buySpinBet: 0,
      clientSeed: randomBytes(8).toString('hex'),
      serverSeed,
      serverSeedHash: serverSeedHash(serverSeed),
      nonce: 0,
      revealed: [],
      history: [],
      createdAt: Date.now(),
      seenAt: Date.now(),
    };
    /* Прив'язка до запрошувача — ДО першого persist, щоб вона потрапила
       в базу разом із рештою запису, а не окремим дописом, який може
       не дійти. Саму виплату робить підписник нижче. */
    const by = Number(String(startParam ?? '').replace(/^ref_?/i, ''));
    if (Number.isInteger(by) && by > 0 && by !== user.id && this.players.has(by)) {
      rec.refBy = by;
    }

    this.players.set(user.id, rec);
    this.persist(rec);
    for (const fn of this.created) fn(rec);
    return rec;
  }

  /* ---- РУХ ГРОШЕЙ ---- (правила й чому саме такі — див. money.ts) */

  /** Скільки в гравця всього. Саме це число бачить він сам. */
  total(rec: PlayerRecord): number {
    return (rec.cash ?? 0) + (rec.bonus ?? 0);
  }

  /** Скільки можна подати на вивід: готівка, і тільки вона. */
  withdrawable(rec: PlayerRecord): number {
    this.settleBonus(rec);
    return Math.max(0, Math.floor(rec.cash ?? 0));
  }

  /* Списати ставку: спершу з бонусу, решта з готівки. Повертає розклад —
     він потрібен, щоб віддати виграш у тій самій пропорції. */
  stake(rec: PlayerRecord, amount: number): MoneySplit {
    const split = splitStake(rec.bonus ?? 0, rec.cash ?? 0, amount);
    rec.bonus = (rec.bonus ?? 0) - split.fromBonus;
    rec.cash = (rec.cash ?? 0) - split.fromCash;
    return split;
  }

  /** Повернути ставку тим самим балансам (раунд не відбувся). */
  refund(rec: PlayerRecord, split: MoneySplit): void {
    rec.bonus = (rec.bonus ?? 0) + split.fromBonus;
    rec.cash = (rec.cash ?? 0) + split.fromCash;
  }

  /** Зарахувати виплату в тій самій пропорції, в якій пішла ставка. */
  payout(rec: PlayerRecord, split: MoneySplit, amount: number): void {
    if (amount <= 0) return;
    const part = splitPayout(split, amount);
    rec.bonus = (rec.bonus ?? 0) + part.fromBonus;
    rec.cash = (rec.cash ?? 0) + part.fromCash;
  }

  /* Оборот. Зараховується сума СТАВКИ з поправкою на contribution —
     виграла вона чи ні, значення не має: відіграш це оборот, а не
     програш. Без активного бонусу лічильник не потрібен взагалі. */
  noteWager(rec: PlayerRecord, amount: number, contribution = CONTRIBUTION.bet): void {
    if (amount <= 0 || (rec.wagerNeed ?? 0) <= 0) return;
    rec.wagerDone = (rec.wagerDone ?? 0) + amount * contribution;
    this.settleBonus(rec);
  }

  /* Стан бонусу після будь-якої зміни: програний, згорів за часом,
     відіграний. Кличеться ЛІНИВО — з руху грошей і з місць, які їх
     показують. Окремий планувальник зайвий: поки гравець нічого не
     робить, різниці між «бонус згорів» і «бонус висить» немає ні для
     кого. */
  settleBonus(rec: PlayerRecord): void {
    if ((rec.wagerNeed ?? 0) <= 0) return;

    /* ПРОГРАНИЙ. Бонусних грошей не лишилось — вимога зникає разом із
       ними: тримати борг за гроші, яких уже немає, безглуздо, відіграти
       його однаково нічим. */
    if ((rec.bonus ?? 0) <= 0) {
      this.log.log(`бонус програно: ${rec.telegramId}, відіграш знято`);
      this.clearBonus(rec);
      return;
    }

    /* ТЕРМІН ВИЙШОВ. Згорає бонусний баланс — готівки це не торкається
       НІКОЛИ, вона до подарунка стосунку не має. */
    if (rec.bonusUntil > 0 && Date.now() > rec.bonusUntil) {
      this.log.warn(`бонус згорів: ${rec.telegramId} -${rec.bonus} бонусних`);
      rec.bonus = 0;
      this.clearBonus(rec);
      return;
    }

    if ((rec.wagerDone ?? 0) < rec.wagerNeed) return;

    /* ВІДІГРАНО: бонус стає готівкою. Але не більше за стелю — усе
       понад неї це виграш безкоштовних грошей, який ми домовились не
       віддавати без межі (BONUS_MAX_CASHOUT_X). */
    let move = rec.bonus ?? 0;
    if (rec.bonusCap > 0 && move > rec.bonusCap) {
      this.log.warn(`стеля бонусу: ${rec.telegramId} зрізано ${move - rec.bonusCap}`);
      move = rec.bonusCap;
    }
    rec.cash = (rec.cash ?? 0) + move;
    rec.bonus = 0;
    this.log.log(`бонус відіграно: ${rec.telegramId} +${move} у готівку`);
    this.clearBonus(rec);
  }

  private clearBonus(rec: PlayerRecord): void {
    rec.wagerNeed = 0;
    rec.wagerDone = 0;
    rec.bonusUntil = 0;
    rec.bonusCap = 0;
  }

  /* Стеля ставки, поки бонус не відіграний. 0 — обмеження немає.

     Без неї відіграш не значить нічого: ціль знімається одним великим
     спіном (див. BONUS_MAX_BET_SHARE). */
  maxBet(rec: PlayerRecord): number {
    if ((rec.wagerNeed ?? 0) <= 0) return 0;
    return Math.max(CONFIG.bets[0], Math.round((rec.bonus ?? 0) * BONUS_MAX_BET_SHARE));
  }

  /* Нарахувати БОНУСНІ гроші: лягають на бонусний баланс і тягнуть за
     собою вимогу відіграшу rub * multiplier.

     Другий бонус не скидає прогрес першого, а додає до вимоги: інакше
     вигідно було б ловити нарахування впритул одне за одним. */
  grantBonus(telegramId: number, rub: number, multiplier: number, why: string): void {
    const rec = this.players.get(telegramId);
    if (!rec || rub <= 0) return;
    /* Спершу розрахуємось зі старим бонусом: він міг згоріти або вже
       бути відіграним, і новий не має успадкувати ні його вимогу, ні
       його стелю. */
    this.settleBonus(rec);

    rec.bonus = (rec.bonus ?? 0) + rub;
    rec.wagerNeed = (rec.wagerNeed ?? 0) + rub * multiplier;
    /* Термін — від ОСТАННЬОГО нарахування: другий бонус продовжує цикл,
       а не доживає на хвості першого. */
    rec.bonusUntil = Date.now() + BONUS_DAYS * 24 * 60 * 60 * 1000;
    rec.bonusCap = (rec.bonusCap ?? 0) + rub * BONUS_MAX_CASHOUT_X;
    this.persist(rec);
    this.log.warn(`бонус (${why}): ${telegramId} +${rub} бонусних, `
      + `відіграти ${rub * multiplier} (усього ${rec.wagerNeed})`);
  }

  /* ---- БЕЗКОШТОВНІ ПРОКРУТИ ----

     Виграш не падає на баланс після кожного прокруту, а накопичується
     (freeSpinWin) і зараховується, коли серія добігла кінця. Так це й
     влаштовано в казино, і причина практична: вимога відіграшу
     рахується від ПІДСУМКУ серії, інакше двадцять дрібних виграшів
     дали б двадцять окремих цілей. */
  noteFreeSpinWin(rec: PlayerRecord, payout: number): void {
    if (payout > 0) rec.freeSpinWin = (rec.freeSpinWin ?? 0) + payout;
  }

  /* Серія скінчилась — зараховуємо підсумок.

     toBonus: подаровані колесом прокрути дають БОНУСНІ гроші (з
     відіграшем), куплені за свої — готівку. Відіграш вішають на
     подарунки, а не на оплачене (див. spins.types). */
  finishFreeSpins(
    rec: PlayerRecord, toBonus: boolean, multiplier: number, why: string,
  ): number {
    const win = rec.freeSpinWin ?? 0;
    rec.freeSpinWin = 0;
    if (win <= 0) return 0;

    if (!toBonus) {
      rec.cash = (rec.cash ?? 0) + win;
      this.log.log(`фріспіни (${why}): ${rec.telegramId} +${win} у готівку`);
      return win;
    }
    this.grantBonus(rec.telegramId, win, multiplier, why);
    return win;
  }

  /* Купівля пакета фріспінів: списуємо ціну, видаємо прокрути.

     Ціну рахує сервер зі ставки (spinsPrice), число з клієнта сюди не
     доходить взагалі — інакше пакет можна було б купити за одиницю. */
  buySpins(rec: PlayerRecord, bet: number): { left: number; bet: number; balance: number } {
    const price = spinsPrice(bet);
    /* ПЛАТИТЬ ТІЛЬКИ ГОТІВКА, і це не дрібниця, а закрита дірка.

       Виграш куплених прокрутів — готівка (за них заплачено своїм).
       Якби ціну можна було внести бонусними грошима, вийшов би прямий
       відмивач: узяв бонус -> купив ним пакет -> отримав виводимі
       гроші, жодного обороту не зробивши. Тому бонус тут не приймаємо
       взагалі. */
    if ((rec.cash ?? 0) < price) {
      throw new BadRequestException(`Недостаточно монет: пакет стоит ${price} ₽`);
    }
    rec.cash -= price;
    const split = { fromBonus: 0, fromCash: price };
    rec.buySpins = FS_PACK;
    rec.buySpinBet = bet;
    /* Ціна пакета — ЦЕ СТАВКА, і в оборот вона йде так само, як ставка
       звичайного раунду. Раніше не йшла, і виходило, що гравець витрачає
       гроші на гру, а відіграш бонусу стоїть на місці. */
    this.noteWager(rec, price);
    this.persist(rec);
    this.log.warn(`куплено ${FS_PACK} фріспінів: ${rec.telegramId} -${price} `
      + `(ставка ${bet}, з бонусу ${split.fromBonus}) -> ${this.total(rec)}`);
    return { left: rec.buySpins, bet, balance: this.total(rec) };
  }

  /* Прогрес відіграшу — для смужки в інтерфейсі. */
  bonusProgress(rec: PlayerRecord): {
    locked: number; done: number; need: number; until: number; maxBet: number;
  } {
    this.settleBonus(rec);
    if ((rec.wagerNeed ?? 0) <= 0) {
      return { locked: 0, done: 0, need: 0, until: 0, maxBet: 0 };
    }
    return {
      locked: rec.bonus ?? 0,
      done: Math.round(rec.wagerDone ?? 0),
      need: Math.round(rec.wagerNeed),
      until: rec.bonusUntil ?? 0,
      maxBet: this.maxBet(rec),
    };
  }

  /** Публічний зріз: без serverSeed, лише його хеш */
  publicState(rec: PlayerRecord) {
    return {
      telegramId: rec.telegramId,
      firstName: rec.firstName,
      username: rec.username ?? null,
      /* Одне число — сума обох балансів. Гравець грає всім разом, і
         ділити баланс у нього перед очима нема потреби: розділення
         показує вікно виводу, де воно щось означає. */
      balance: this.total(rec),
      dryStreaks: rec.dryStreaks,
      /* Клієнт малює по цьому плашку «БОНУС ГЕЙМ» і блокує зміну
         ставки: наступний раунд усе одно піде на збереженій. */
      pendingBonus: rec.pendingBonus ?? null,
      /* Подаровані прокрути видно в тому ж зрізі, що й баланс: клієнт
         малює по них плашку й розуміє, чому наступний спін безкоштовний. */
      freeSpins: rec.freeSpins ?? 0,
      /* Куплені прокрути — окремо від подарованих: у них інша ставка й
         інший шанс, і плутати їх в інтерфейсі не можна. */
      buySpins: rec.buySpins ?? 0,
      buySpinBet: rec.buySpinBet ?? 0,
      /* Розклад для вікна виводу: скільки з цього числа готівка, а
         скільки бонус у відіграші. */
      cash: Math.max(0, Math.floor(rec.cash ?? 0)),
      bonus: rec.bonus ?? 0,
      pityAt: CONFIG.pity,
      clientSeed: rec.clientSeed,
      serverSeedHash: rec.serverSeedHash,
      nonce: rec.nonce,
    };
  }

  setClientSeed(rec: PlayerRecord, clientSeed: string): PlayerRecord {
    rec.clientSeed = clientSeed.trim().slice(0, 128) || rec.clientSeed;
    this.persist(rec);
    return rec;
  }

  /** Викликається в кінці кожного раунду — тут і зберігаємо гравця в БД
      (баланс, nonce, dryStreak, історія — усе свіже). */
  pushHistory(rec: PlayerRecord, result: RoundResult): void {
    rec.history.unshift(result);
    if (rec.history.length > HISTORY_LIMIT) rec.history.length = HISTORY_LIMIT;
    this.persist(rec);
  }

  /* ---- для CRM (доступ під адмін-логіном, див. admin/) ---- */

  /** Усі заведені гравці. */
  all(): PlayerRecord[] {
    return [...this.players.values()];
  }

  /** Гравець за telegram id або undefined. */
  byId(telegramId: number): PlayerRecord | undefined {
    return this.players.get(telegramId);
  }

  /** Списати з балансу. Використовується для РЕЗЕРВУ під виведення:
      гроші йдуть з балансу в момент заявки, а не коли адмін її погодить.

      Інакше гравець міг би замовити виплату й далі грати цими самими
      грошима: програв — на балансі нуль, а заявка все одно чекає
      виплати. Повертає розрізнений результат, щоб той, хто кличе, не
      сплутав «немає гравця» з «не вистачає коштів». */
  charge(telegramId: number, amount: number, by = 'система'):
  { ok: true; balance: number } | { ok: false; reason: 'no-player' | 'low-balance' } {
    const rec = this.players.get(telegramId);
    if (!rec) return { ok: false, reason: 'no-player' };
    /* Списуємо з ГОТІВКИ, а не з суми балансів: цим методом іде вивід,
       а бонусні гроші не виводяться за визначенням. Списати їх тут
       означало б віддати те, що ще має бути відігране. */
    if (this.withdrawable(rec) < amount) return { ok: false, reason: 'low-balance' };
    rec.cash -= amount;
    this.persist(rec);
    this.log.warn(`списання (${by}): ${telegramId} -${amount} -> ${this.total(rec)}`);
    return { ok: true, balance: this.total(rec) };
  }

  /** Ручне поповнення балансу. Повертає новий баланс або null, якщо
      такого гравця нема — той, хто кличе, ЗОБОВ'ЯЗАНИЙ це перевірити:
      null означає, що гроші не нараховані. */
  topUp(telegramId: number, amount: number, by = 'система'): number | null {
    const rec = this.players.get(telegramId);
    if (!rec) return null;
    /* Депозит і ручне поповнення — ГОТІВКА: відіграшу вони не вимагають
       (див. коментар до wagerNeed). Подарунки йдуть іншим шляхом —
       grantBonus. */
    rec.cash = (rec.cash ?? 0) + amount;
    this.persist(rec);
    this.log.warn(`поповнення (${by}): ${telegramId} +${amount} -> ${this.total(rec)}`);
    return this.total(rec);
  }

  /* Обнулити баланс.

     Не «списати скільки треба», а саме поставити нуль: інструмент для
     випадку, коли гроші нараховані помилково або гравця спіймали на
     зловживанні, і рахувати різницю руками — зайвий шанс помилитись.

     Скільки саме зняли, повертаємо назад тому, хто кличе, і пишемо в
     лог: обнулення необоротне, і слід від нього має лишитись. */
  zeroBalance(telegramId: number, by = 'система'):
  { balance: number; taken: number } | null {
    const rec = this.players.get(telegramId);
    if (!rec) return null;
    /* Обнулення забирає ВСЕ — і готівку, і бонус разом із його
       вимогою: це інструмент проти зловживання, і лишати зловмиснику
       половину грошей було б дивно. */
    const taken = this.total(rec);
    rec.cash = 0;
    rec.bonus = 0;
    this.clearBonus(rec);
    this.persist(rec);
    this.log.warn(`обнулення (${by}): ${telegramId} -${taken} -> 0`);
    return { balance: 0, taken };
  }

  /* Видалити гравця НАЗАВЖДИ.

     Разом із ним зникають баланс, сид, nonce й історія раундів. Заявки
     на депозит і виведення живуть в інших колекціях і лишаються: це
     фінансові документи, і чистити їх заднім числом не можна — саме за
     ними потім і розбирають, куди пішли гроші.

     Зайде в гру знову — заведеться заново, з нуля й новим сидом. */
  remove(telegramId: number, by = 'система'): boolean {
    const rec = this.players.get(telegramId);
    if (!rec) return false;
    this.players.delete(telegramId);
    this.store?.delete(telegramId).catch((e) =>
      this.log.error(`не видалився гравець ${telegramId}: ${(e as Error).message}`));
    this.log.warn(`видалення (${by}): ${telegramId}, баланс на момент ${this.total(rec)}`);
    return true;
  }
}
