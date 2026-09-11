import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CONFIG, TIER_BY_ID, resolveRound, roundCost } from '@minedrop/engine';
import type { RoundMode, RoundResult, TierId } from '@minedrop/engine';
import { PlayersService, type PlayerRecord } from '../players/players.service';
import { FairnessService } from '../fairness/fairness.service';
import { WHEEL_FREE_BET, WHEEL_WIN_WAGER_X } from '../wheel/wheel.types';
import { FS_CHANCE_X } from '../spins/spins.types';
import { CONTRIBUTION } from '../players/money';

/* ============================================================
   ROUNDS — тут вирішується результат. Єдина точка, де рухаються гроші.

   Порядок навмисно такий:
     1. перевірили ставку й режим;
     2. списали вартість;
     3. взяли сид (nonce += 1) і ПОВНІСТЮ програли раунд у рушії;
     4. нарахували виплату;
     5. оновили стрік.
   Клієнт отримує сид і сам відтворює політ — але його арифметика
   ні на що не впливає, у балансі вже лежить серверне число.
   ============================================================ */

/* Скільки тримати відповідь під ключем ідемпотентності.
   Вистачає, щоб покрити ретраї обірваного запиту, і мало, щоб
   кеш не ріс. */
const IDEMPOTENCY_TTL_MS = 60_000;

@Injectable()
export class RoundsService {
  /** (telegramId + ключ) -> уже зіграний раунд */
  private readonly recent = new Map<string, { at: number; round: RoundResult }>();

  constructor(
    private readonly players: PlayersService,
    private readonly fairness: FairnessService,
  ) {}

  play(rec: PlayerRecord, bet: number, mode: RoundMode,
       idempotencyKey?: string, buy?: TierId): RoundResult {
    /* Ретрай того самого запиту не має списувати ставку вдруге.
       У вебв'ю телеграма мережа рветься регулярно, тож це не
       теоретичний випадок. */
    const key = idempotencyKey ? `${rec.telegramId}:${idempotencyKey.slice(0, 80)}` : null;
    if (key) {
      this.sweep();
      const hit = this.recent.get(key);
      if (hit) return hit.round;
    }

    const round = this.settle(rec, bet, mode, buy);
    if (key) this.recent.set(key, { at: Date.now(), round });
    return round;
  }

  private sweep(): void {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [k, v] of this.recent) if (v.at < cutoff) this.recent.delete(k);
  }

  private settle(rec: PlayerRecord, bet: number, mode: RoundMode, buy?: TierId): RoundResult {
    /* ВИГРАНА БОНУСКА.

       Якщо гравець зібрав скаттери минулого раунду, наступна звичайна
       ставка перетворюється на безкоштовну бонуску. Ставку беремо
       СЕРВЕРНУ, збережену разом із виграшем, а не ту, що надіслав
       клієнт: виплата рахується від ставки раунду, тож інакше скаттери
       на 10 монетах перетворювались би на бонуску за 5000.

       Явна купівля бонуски виграну не витрачає — гравець заплатив за
       іншу річ, а ця дочекається наступної звичайної ставки. */
    const free = !buy && !!rec.pendingBonus;
    if (free) bet = rec.pendingBonus!.bet;

    /* ПОДАРОВАНИЙ ПРОКРУТ З КОЛЕСА.

       Це НЕ те саме, що `free` вище: там безкоштовна БОНУСКА, виграна
       скаттерами (інша шахта, гарантована кірка). Тут — звичайний
       раунд, за який просто не списують гроші.

       Черга саме така: спершу виграна бонуска, потім подарований
       прокрут. Бонуска прив'язана до своєї ставки й чекає першої ж
       звичайної ставки — якби подарунок ліз поперед неї, він з'їдав би
       цю чергу й відкладав бонуску невідомо на коли.

       Куплений бонус бай подарунка теж не витрачає: гравець заплатив
       за іншу річ.

       Ставка ФІКСОВАНА сервером (WHEEL_FREE_BET), а не взята з запиту:
       інакше перед подарованим прокрутом вистачило б виставити
       максимальну ставку. Через це ж вона не звіряється зі списком
       дозволених нижче — сервер підставляє своє число, а не чуже. */
    /* КУПЛЕНИЙ ПАКЕТ ФРІСПІНІВ.

       Йде ПОПЕРЕД подарунків колеса: за нього заплачено, і тримати
       оплачене в черзі за безкоштовним було б щонайменше дивно.
       Ставка — та, за якою пакет куплений; шанс кірки подвоєний
       (FS_CHANCE_X), виграш замикається на відіграш (нижче). */
    const paidSpin = !buy && !free && (rec.buySpins ?? 0) > 0;
    if (paidSpin) bet = rec.buySpinBet;

    const gift = !buy && !free && !paidSpin && (rec.freeSpins ?? 0) > 0;
    if (gift) bet = WHEEL_FREE_BET;

    /* Ставку клієнта звіряємо зі списком дозволених ЛИШЕ коли вона й
       справді йде в гру: у безкоштовній бонусці сервер однаково бере
       своє збережене число (рядок вище), а надіслане клієнтом ігнорує
       повністю. Перевірка ДО цього моменту відмовляла б у цілком
       робочому безкоштовному раунді через довільне число в тілі
       запиту, яке ні на що вже не впливає. */
    if (!free && !gift && !paidSpin && !CONFIG.bets.includes(bet as never)) {
      throw new BadRequestException(`Ставка должна быть одной из: ${CONFIG.bets.join(', ')}`);
    }

    /* БОНУС БАЙ. Кірку називає клієнт, тому перевіряємо тут: неіснуючий
       тір або тір без ціни — відмова. Ціну бере рушій із CONFIG.buy,
       клієнт її лише показує і на неї не впливає. */
    if (buy && (!TIER_BY_ID[buy] || !CONFIG.buy.price[buy])) {
      throw new BadRequestException('Неизвестная кирка');
    }
    /* Режим виводиться з buy, а не з того, що написав клієнт. Просити
       бонуску, не назвавши кірку, — суперечливий запит: мовчки зіграти
       звичайну ставку за цінником бонуски було б найгіршим варіантом. */
    if (mode === 'buy' && !buy) {
      throw new BadRequestException('Не выбрана кирка для бонус бая');
    }

    /* СТЕЛЯ СТАВКИ, ПОКИ БОНУС НЕ ВІДІГРАНИЙ.

       Без неї відіграш нічого не означає: ціль у 2000 ₽ знімається
       одним спіном на 2000 ₽, і гравець із грошима на балансі
       перетворює бонус на підкидання монетки. Перевіряємо лише те, що
       гравець ставить САМ: подаровані й куплені прокрути йдуть за своєю
       ставкою, яку він у цей момент не обирає. */
    if (!gift && !paidSpin) {
      const capBet = this.players.maxBet(rec);
      if (capBet > 0 && bet > capBet) {
        throw new BadRequestException(
          `Пока бонус в отыгрыше, максимальная ставка ${capBet} ₽`);
      }
    }

    const freeSpin = gift || paidSpin;
    const cost = freeSpin ? 0 : roundCost(mode, bet, buy, free);
    if (this.players.total(rec) < cost) {
      throw new BadRequestException('Недостаточно монет');
    }

    const balanceBefore = this.players.total(rec);
    /* СТАВКА. Списується спершу з бонусу, решта з готівки; розклад
       зберігаємо, бо виплата має піти в тій самій пропорції — інакше
       з'явився б спосіб «відмити» бонус: поставив бонусними, забрав
       виграш готівкою (див. money.ts).

       Безкоштовний прокрут не списує нічого, тож і розклад у нього
       порожній: його виграш іде окремим шляхом, нижче. */
    const split = freeSpin
      ? { fromBonus: 0, fromCash: 0 }
      : this.players.stake(rec, cost);

    /* ОБОРОТ. Безкоштовні прокрути коштують нуль, але ставку на полі
       роблять справжню — у казино вони зараховуються за номіналом.
       Інакше виходило б, що гравець грає, а відіграш стоїть.

       Бонус бай має власну частку (CONTRIBUTION.buy): це той самий
       важіль, яким казино виключають feature buy із відіграшу. */
    this.players.noteWager(
      rec, freeSpin ? bet : cost, buy ? CONTRIBUTION.buy : CONTRIBUTION.bet);

    /* PITY рахується ОКРЕМО на кожній ставці. Серія на ставці 10 нічого
       не дає на ставці 250 — тож набити промахи по 10 і зняти гарантовану
       кірку на 250 не вийде. Перемкнувся туди-сюди — серія кожної ставки
       чекає на місці. */
    /* Куплена кірка гарантована сама по собі, тож серію промахів вона
       не витрачає: pity лишається на місці й спрацює на звичайній
       ставці, як і мав. */
    /* Безкоштовна бонуска, як і куплена, кірку має гарантовано — тож
       серію промахів вона не витрачає. */
    /* Подарований прокрут — звичайний раунд у всьому, крім ціни, тож
       pity на ньому працює як завжди: серія промахів і накопичується,
       і спрацьовує. Інакше подарунок був би ще й дірою в гарантії. */
    const streak = rec.dryStreaks[bet] ?? 0;
    /* Гарантії не отримують і серії не рухають ані куплені прокрути
       (у них своя, вища ймовірність кірки — саме з неї рахувалась ціна
       пакета), ані подаровані колесом: інакше п'ять безкоштовних
       промахів підводили б лічильник, і гарантію на СВОЇЙ ставці
       гравець отримував би за чужий рахунок. */
    const pity = !buy && !free && !paidSpin && !gift && streak >= CONFIG.pity;

    const { seed, nonce } = this.fairness.nextSeed(rec);
    const chanceX = paidSpin ? FS_CHANCE_X : 1;
    const resolved = resolveRound(seed, mode, bet, pity, buy, free, chanceX);

    /* ВИПЛАТА.

       Звичайний раунд — одразу на баланси, у пропорції ставки.

       Безкоштовний прокрут — НЕ на баланс, а в накопичувач серії. Гроші
       зараховуються, коли серія добігла кінця: вимога відіграшу
       рахується від ПІДСУМКУ серії, інакше двадцять дрібних виграшів
       дали б двадцять окремих цілей (див. players.finishFreeSpins). */
    if (freeSpin) this.players.noteFreeSpinWin(rec, resolved.payout);
    else this.players.payout(rec, split, resolved.payout);

    /* Виграну бонуску списуємо ПІСЛЯ прогону — до цього моменту раунд
       ще міг не відбутись через кинуту помилку, і тоді вона мала б
       лишитись гравцю.

       Порядок «спершу списали стару, потім записали нову» принциповий:
       скаттери працюють і всередині бонуски, тож ретригер має видати
       наступну, а не бути стертим списанням цієї. */
    if (free) rec.pendingBonus = null;
    if (resolved.bonusWon) rec.pendingBonus = { bet };

    /* Подарунок списуємо ПІСЛЯ прогону — з тієї ж причини, що й
       бонуску вище: до цього рядка раунд ще міг не відбутись через
       кинуту помилку, і тоді прокрут мав лишитись гравцю. */
    if (gift) {
      rec.freeSpins = Math.max(0, (rec.freeSpins ?? 0) - 1);
      /* Серія закінчилась — підсумок на баланс. Подаровані колесом
         прокрути дають БОНУСНІ гроші з відіграшем: вони безкоштовні.
         Куплені за свої — готівку, бо відіграш вішають на подарунки, а
         не на оплачене. */
      if (rec.freeSpins === 0) {
        this.players.finishFreeSpins(rec, true, WHEEL_WIN_WAGER_X, 'колесо');
      }
    }
    if (paidSpin) {
      rec.buySpins = Math.max(0, (rec.buySpins ?? 0) - 1);
      if (rec.buySpins === 0) {
        this.players.finishFreeSpins(rec, false, 0, 'куплений пакет');
      }
    }

    /* Лічильник пустих прокрутів цієї ставки: кірка (у т.ч. форсована)
       -> 0, промах -> +1. Інші ставки не чіпаємо. Подаровані раунди
       (куплені й виграні) серію не рухають узагалі. */
    const nextStreak = (buy || free || paidSpin || gift)
      ? streak
      : (resolved.setup.tiers.length ? 0 : streak + 1);
    rec.dryStreaks[bet] = nextStreak;

    const result: RoundResult = {
      roundId: randomUUID(),
      mode: resolved.setup.mode,
      bet,
      cost,
      buy,
      free: resolved.setup.free,
      /* Подарований колесом прокрут. Клієнту це потрібно, щоб показати
         «бесплатный прокрут» замість списаної ставки, а CRM — щоб
         відрізняти подарунок від оплаченого раунду в історії. */
      gift,
      /* Множник шансу — щоб клієнт зібрав ТУ САМУ рулетку з того ж
         сида. Без нього куплений прокрут розійшовся б із сервером. */
      chanceX,
      /** цей раунд зіграно купленим прокрутом */
      paidSpin,
      bonusWon: resolved.bonusWon,
      seed,
      spins: resolved.setup.spins,
      tiers: resolved.setup.tiers,
      startCols: resolved.setup.startCols,
      pity: resolved.setup.pity,
      dryStreak: nextStreak,
      sim: resolved.sim,
      rawPayout: resolved.rawPayout,
      payout: resolved.payout,
      capped: resolved.capped,
      multiplier: cost > 0 ? resolved.payout / cost : resolved.payout / bet,
      balanceBefore,
      balanceAfter: this.players.total(rec),
      fair: {
        serverSeedHash: rec.serverSeedHash,
        clientSeed: rec.clientSeed,
        nonce,
      },
    };

    this.players.pushHistory(rec, result);
    return result;
  }
}
