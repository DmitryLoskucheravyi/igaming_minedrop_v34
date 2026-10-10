import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { DailyClaim, DailyState } from '@minedrop/contracts';
import { ENV, type Env } from '../config/env';
import { PlayersService, type PlayerRecord } from '../players/players.service';
import {
  DAILY_REFILL, STREAK_COINS, dayKey, nextDayAt, streakDay,
} from './daily.types';

/* ============================================================
   ЩОДЕННА НАГОРОДА: поповнення + серія заходів.

   Раз на календарну добу гравець забирає DAILY_REFILL і нагороду
   поточного дня серії. Коіни нараховує СЕРВЕР і тільки сервер: клієнт
   лише показує календар і кнопку, а який сьогодні день серії —
   вирішується тут, за датою останнього отримання.

   Чому «забрати», а не нараховувати мовчки при вході: нагорода, яку
   людина не побачила, — не нагорода. Вікно відкривається саме на
   старті гри, тож на практиці це один дотик.
   ============================================================ */

@Injectable()
export class DailyService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly players: PlayersService,
  ) {}

  state(rec: PlayerRecord, now = Date.now()): DailyState {
    const today = dayKey(now, this.env.dailyTz);
    return {
      ready: rec.dailyDay !== today,
      day: streakDay(rec.dailyDay, rec.streak ?? 0, today),
      refill: DAILY_REFILL,
      rewards: [...STREAK_COINS],
      nextAt: nextDayAt(now, this.env.dailyTz),
      now,
    };
  }

  claim(rec: PlayerRecord): DailyClaim {
    const now = Date.now();
    const today = dayKey(now, this.env.dailyTz);
    if (rec.dailyDay === today) {
      throw new BadRequestException('Награда за сегодня уже получена');
    }

    const day = streakDay(rec.dailyDay, rec.streak ?? 0, today);
    const streak = STREAK_COINS[day - 1] ?? 0;
    const total = DAILY_REFILL + streak;

    /* Позначка дня — ДО нарахування й в тому ж записі: credit()
       зберігає гравця цілком, тож доба й коіни лягають у базу разом.
       Окремими записами повтор запиту між ними видав би нагороду двічі. */
    rec.dailyDay = today;
    rec.streak = day;
    const balance = this.players.credit(rec.telegramId, total, `щоденна, день ${day}`)
      ?? this.players.balance(rec);

    return { day, refill: DAILY_REFILL, streak, total, balance, state: this.state(rec, now) };
  }
}
