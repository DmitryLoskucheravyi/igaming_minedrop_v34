import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { PlayersService, type PlayerRecord } from '../players/players.service';
import { BotService } from '../telegram/bot.service';

/* ============================================================
   РЕФЕРАЛЬНА СИСТЕМА.

   Одна нагорода запрошувачу — REF_JOIN_COINS, коли друг прийшов за
   його посиланням.

   ЧОМУ ОЗНАКА ВИПЛАТИ ЛЕЖИТЬ У ЗАПРОШЕНОГО. Подія належить йому, а
   виплата лише її наслідок. Поки прапорець стоїть у того, з ким подія
   сталася, повторно оплатити її неможливо в принципі: немає такого
   порядку дій, за якого «друг прийшов» настане двічі.
   ============================================================ */

/** скільки коінів отримує запрошувач, коли друг прийшов */
export const REF_JOIN_COINS = 500;

export interface ReferralFriend {
  telegramId: number;
  name: string;
  /** коли прийшов */
  at: number;
  /** скільки коінів ми на ньому заробили */
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
    /* Запрошувача може вже не бути (видалили акаунт) — тоді нічого не
       нараховано, і позначати виплату як зроблену не можна. */
    if (this.players.credit(rec.refBy, REF_JOIN_COINS, `друг ${rec.telegramId}`) === null) return;
    rec.refJoinPaidAt = Date.now();
    this.players.persist(rec);
  }

  /* Список друзів. Рахується перебором гравців, а не окремим списком у
     запрошувача: копія списку — це друге джерело правди, яке рано чи
     пізно розійдеться з першим. Гравці й так усі в пам'яті. */
  friends(rec: PlayerRecord): ReferralFriend[] {
    const out: ReferralFriend[] = [];
    for (const p of this.players.all()) {
      if (p.refBy !== rec.telegramId) continue;
      out.push({
        telegramId: p.telegramId,
        name: p.firstName || (p.username ? '@' + p.username : 'Друг'),
        at: p.createdAt,
        earned: p.refJoinPaidAt ? REF_JOIN_COINS : 0,
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
      joinCoins: REF_JOIN_COINS,
      earned: friends.reduce((a, f) => a + f.earned, 0),
      friends,
    };
  }
}
