import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { PlayersService, type PlayerRecord } from '../players/players.service';
import { BotService } from '../telegram/bot.service';

/* ============================================================
   РЕФЕРАЛЬНА СИСТЕМА.

   Дві виплати запрошувачу, і обидві — за подію в житті ЗАПРОШЕНОГО:
     прийшов за посиланням              -> REF_JOIN_RUB
     заніс депозитами REF_DEPOSIT_MIN   -> REF_DEPOSIT_RUB

   ЧОМУ ОЗНАКИ ВИПЛАТ ЛЕЖАТЬ У ЗАПРОШЕНОГО. Подія належить йому, а
   виплата лише її наслідок. Поки прапорець стоїть у того, з ким подія
   сталася, повторно оплатити її неможливо в принципі: немає такого
   порядку дій, за якого «перший депозит» настане двічі. Якби лічильник
   жив у запрошувача, довелось би зіставляти списки й вірити, що вони
   не розійшлись.

   ДЕПОЗИТ — ЗВІДКИ ЗАВГОДНО. Сума накопичується і з погодженої заявки
   (бот або адмін), і з ручного зарахування неопізнаного переказу: для
   гравця це однаково «я заніс гроші», і рахувати одне, а друге ні —
   означало б карати його за те, що переказ довелось зіставляти руками.
   ============================================================ */

/** скільки отримує запрошувач, коли друг просто прийшов */
export const REF_JOIN_RUB = 100;
/** ...і скільки додатково, коли друг занесе REF_DEPOSIT_MIN */
export const REF_DEPOSIT_RUB = 200;

/* Поріг депозиту для другої виплати. Рахується НАКОПИЧУВАЛЬНО: друг,
   який заніс 150 і ще 150, вніс ті самі 300, і відмовляти йому через
   те, що переказів було два, — правило нізвідки. */
export const REF_DEPOSIT_MIN = 300;

export interface ReferralFriend {
  telegramId: number;
  name: string;
  /** коли прийшов */
  at: number;
  /** коли добив поріг депозиту (null — ще ні) */
  depositedAt: number | null;
  /** скільки вже вніс депозитами, ₽ — щоб було видно, чи близько поріг */
  deposited: number;
  /** скільки ми на ньому заробили, ₽ */
  earned: number;
}

@Injectable()
export class ReferralsService implements OnModuleInit {
  private readonly log = new Logger(ReferralsService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly players: PlayersService,
    private readonly bot: BotService,
  ) {}

  onModuleInit(): void {
    /* Підписка, а не виклик із PlayersService: напрямок залежностей
       лишається одним — сюди, а не звідси (див. коментар до onCreated). */
    this.players.onCreated((rec) => this.payJoin(rec));
  }

  /** Код, який гравець роздає друзям. Це просто його telegram-id:
      окремий словник кодів довелось би зберігати й стерегти від
      колізій, а виграшу від нього — нуль. */
  code(rec: PlayerRecord): string {
    return String(rec.telegramId);
  }

  /* Посилання на бота зі стартовим параметром. Ім'я бота беремо з
     самого бота (getMe при старті), а не з env: одна змінна менше, і
     вона не може розійтися з тим, до кого насправді підключені. */
  link(rec: PlayerRecord): string | null {
    const name = this.bot.username;
    if (!name) return null;
    return `https://t.me/${name}?start=ref_${this.code(rec)}`;
  }

  private payJoin(rec: PlayerRecord): void {
    if (!rec.refBy || rec.refJoinPaidAt) return;
    const paid = this.players.topUp(rec.refBy, REF_JOIN_RUB, 'реферал: друг прийшов');
    /* topUp повертає null, якщо запрошувача вже немає (видалили
       акаунт). Тоді прапорець НЕ ставимо: гроші не нараховані, і
       позначати виплату як зроблену не можна. */
    if (paid === null) return;
    rec.refJoinPaidAt = Date.now();
    this.players.persist(rec);
    this.log.log(`реферал: ${rec.refBy} +${REF_JOIN_RUB} за прихід ${rec.telegramId}`);
  }

  /* Депозит запрошеного. Кличеться з усіх місць, де депозит реально
     лягає на баланс, і з РЕАЛЬНО зарахованою сумою.

     Сума накопичується завжди — навіть у гравця без запрошувача й
     навіть після виплати: це просто факт його життя, і рахувати його
     вибірково означало б отримати поле, якому не можна вірити.
     А ось виплата робиться рівно один раз і лише коли набралось
     REF_DEPOSIT_MIN. */
  onDeposit(telegramId: number, rub: number): void {
    const rec = this.players.byId(telegramId);
    if (!rec) return;
    if (rub > 0) {
      rec.refDeposited = (rec.refDeposited ?? 0) + rub;
      this.players.persist(rec);
    }

    if (!rec.refBy || rec.refDepositPaidAt) return;
    if ((rec.refDeposited ?? 0) < REF_DEPOSIT_MIN) return;

    const paid = this.players.topUp(rec.refBy, REF_DEPOSIT_RUB, 'реферал: депозит друга');
    if (paid === null) return;
    rec.refDepositPaidAt = Date.now();
    this.players.persist(rec);
    this.log.log(
      `реферал: ${rec.refBy} +${REF_DEPOSIT_RUB} за депозити ${rec.telegramId} `
      + `(${rec.refDeposited} ₽)`);
  }

  /* Список друзів. Рахується перебором гравців, а не окремим списком у
     запрошувача: копія списку — це другий источник правди, який рано
     чи пізно розійдеться з першим. Гравці й так усі в пам'яті. */
  friends(rec: PlayerRecord): ReferralFriend[] {
    const out: ReferralFriend[] = [];
    for (const p of this.players.all()) {
      if (p.refBy !== rec.telegramId) continue;
      out.push({
        telegramId: p.telegramId,
        name: p.firstName || (p.username ? '@' + p.username : 'Друг'),
        at: p.createdAt,
        depositedAt: p.refDepositPaidAt,
        deposited: p.refDeposited ?? 0,
        earned: (p.refJoinPaidAt ? REF_JOIN_RUB : 0) + (p.refDepositPaidAt ? REF_DEPOSIT_RUB : 0),
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  state(rec: PlayerRecord) {
    const friends = this.friends(rec);
    return {
      code: this.code(rec),
      link: this.link(rec),
      /* Запасний варіант для випадку, коли ім'я бота ще не приїхало
         (getMe не встиг) або гру відкрили поза телеграмом: показати
         сам код усе одно краще, ніж порожнє місце. */
      webAppUrl: this.env.webAppUrl,
      joinRub: REF_JOIN_RUB,
      depositRub: REF_DEPOSIT_RUB,
      depositMin: REF_DEPOSIT_MIN,
      earned: friends.reduce((a, f) => a + f.earned, 0),
      friends,
    };
  }
}
