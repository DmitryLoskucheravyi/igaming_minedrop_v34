import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PlayersService, type PlayerRecord } from '../players/players.service';
import {
  WHEEL_COOLDOWN_MS, WHEEL_FIRST_PRIZE, WHEEL_FREE_BET, WHEEL_PRIZES,
  type WheelPrize,
} from './wheel.types';

/* ============================================================
   КОЛЕСО ЩОДЕННОГО БОНУСУ.

   Один прокрут при першому вході й далі один на добу. Гроші нараховує
   СЕРВЕР і тільки сервер: клієнт показує анімацію вже за готовим
   результатом, тому «прокрутити ще раз, поки не сподобається» не
   працює — приз визначено до того, як колесо почало крутитись.

   ЧОМУ ВИПАДКОВІСТЬ НЕ З ПОТОКУ РАУНДІВ. Чесність раундів тримається
   на парі server/client seed із розкриттям — гравець має змогу
   перевірити кожен прокрут. Колесо в цю схему не входить (перевіряти
   подарунок нема сенсу), а якби воно тягнуло числа з того ж потоку —
   зсувало б nonce і ламало відтворюваність раундів. Тому тут звичайний
   криптографічний randomInt.
   ============================================================ */

export interface WheelState {
  /** чи можна крутити прямо зараз */
  ready: boolean;
  /** коли можна буде (мс epoch); null — можна вже */
  nextAt: number | null;
  /** серверний час — щоб клієнт порахував поправку до свого годинника */
  now: number;
  /** чи це буде перший прокрут акаунта (тоді приз гарантований) */
  first: boolean;
  /** скільки безкоштовних прокрутів уже лежить у гравця */
  freeSpins: number;
  /* Ставка подарованих прокрутів. Їде по дроту, щоб клієнт не тримав
     власної копії числа: розійдуться — і гравцю пообіцяють одне, а
     зіграє він інше. */
  freeBet: number;
  /** сектори — клієнт малює колесо звідси, своєї копії не тримає */
  prizes: { id: string; label: string }[];
}

@Injectable()
export class WheelService {
  private readonly log = new Logger(WheelService.name);

  constructor(private readonly players: PlayersService) {}

  private nextAt(rec: PlayerRecord): number | null {
    return rec.wheelAt ? rec.wheelAt + WHEEL_COOLDOWN_MS : null;
  }

  state(rec: PlayerRecord): WheelState {
    const next = this.nextAt(rec);
    const now = Date.now();
    return {
      ready: next === null || now >= next,
      nextAt: next,
      now,
      first: !rec.wheelAt,
      freeSpins: rec.freeSpins ?? 0,
      freeBet: WHEEL_FREE_BET,
      prizes: WHEEL_PRIZES.map((p) => ({ id: p.id, label: p.label })),
    };
  }

  /* Жеребкування за вагами. randomInt(total) дає рівномірне ціле без
     перекосу, який дає Math.floor(Math.random() * n) на краях. */
  private draw(): WheelPrize {
    let total = 0;
    for (const p of WHEEL_PRIZES) total += p.weight;
    let x = randomInt(total);
    for (const p of WHEEL_PRIZES) {
      x -= p.weight;
      if (x < 0) return p;
    }
    return WHEEL_PRIZES[0];
  }

  spin(rec: PlayerRecord): { prize: WheelPrize; index: number; state: WheelState; balance: number } {
    const next = this.nextAt(rec);
    if (next !== null && Date.now() < next) {
      throw new BadRequestException('Колесо будет доступно позже');
    }

    /* Перший прокрут акаунта — гарантований приз, без жеребкування. */
    const prize = rec.wheelAt
      ? this.draw()
      : WHEEL_PRIZES.find((p) => p.id === WHEEL_FIRST_PRIZE)!;

    /* Індекс сектора віддаємо окремо від самого призу: тих самих 25 ₽
       на колесі два сектори, і клієнт має зупинити стрілку саме на
       тому, який виграв. indexOf шукає за ПОСИЛАННЯМ (draw і find
       повертають сам елемент масиву), тому дублікати не плутаються. */
    const index = WHEEL_PRIZES.indexOf(prize);

    rec.wheelAt = Date.now();
    if (prize.spins) rec.freeSpins = (rec.freeSpins ?? 0) + prize.spins;
    /* Гроші — через topUp, а не rec.balance += : там і збереження, і
       запис у лог. Нарахування балансу поза цим методом лишало б
       безслідні надходження, а саме за ними й дивляться, коли сходиться
       каса. */
    if (prize.rub) this.players.topUp(rec.telegramId, prize.rub, 'колесо');
    else this.players.persist(rec);

    this.log.log(`колесо: ${rec.telegramId} -> ${prize.label}`);
    return { prize, index, state: this.state(rec), balance: rec.balance };
  }
}
