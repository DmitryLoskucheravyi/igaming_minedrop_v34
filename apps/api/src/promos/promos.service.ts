import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MongoService } from '../db/mongo.service';
import { PlayersService } from '../players/players.service';
import { PromoStore } from './promo-store';
import {
  normalizeCode, PROMO_CODE_MAX, PROMO_MAX_PERCENT, PROMO_WAGER_X, type PromoCode,
} from './promo.types';

/* ============================================================
   ПРОМОКОДИ.

   Сервіс відповідає рівно на три питання:
     - які коди є (CRM);
     - чи можна застосувати ось цей рядок від гравця (percentFor);
     - нарахувати надбавку за погодженою заявкою (grant).

   Про заявки він не знає нічого: йому передають telegramId і суму, а
   не PaymentRecord. Завдяки цьому залежність іде в один бік
   (платежі -> промокоди), і кільця, яке довелось би розв'язувати
   forwardRef, не виникає.
   ============================================================ */

@Injectable()
export class PromosService implements OnModuleInit {
  private readonly log = new Logger(PromosService.name);
  private readonly items = new Map<string, PromoCode>();
  private store: PromoStore | null = null;

  constructor(
    private readonly mongo: MongoService,
    private readonly players: PlayersService,
  ) {}

  async onModuleInit(): Promise<void> {
    const db = await this.mongo.ready();
    if (db) {
      this.store = new PromoStore(db);
      for (const p of await this.store.loadAll()) this.items.set(p.id, p);
      this.log.log(`Завантажено промокодів: ${this.items.size}`);
    }
  }

  private persist(p: PromoCode): void {
    this.store?.save(p).catch((e: unknown) =>
      this.log.error(`промокод ${p.code} не зберігся: ${(e as Error).message}`));
  }

  /* ---- CRM ---- */

  list(): PromoCode[] {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  add(rawCode: string, percent: number): PromoCode {
    const code = normalizeCode(rawCode);
    if (code.length < 2) {
      throw new BadRequestException('Промокод слишком короткий');
    }
    /* Тільки латиниця, цифри, дефіс і підкреслення. Кирилиця тут —
       пастка: «ОТКРЫТИЕ» кирилицею й латиницею виглядають однаково, а
       це різні коди, і розбиратись доведеться вже зі скаргою гравця. */
    if (!/^[A-Z0-9_-]+$/.test(code)) {
      throw new BadRequestException('Только латиница, цифры, дефис и подчёркивание');
    }
    if (this.find(code)) {
      throw new ConflictException('Такой промокод уже есть');
    }
    if (!Number.isFinite(percent) || percent <= 0 || percent > PROMO_MAX_PERCENT) {
      throw new BadRequestException(`Процент должен быть от 1 до ${PROMO_MAX_PERCENT}`);
    }

    const p: PromoCode = {
      id: randomUUID(),
      code,
      percent: Math.round(percent),
      active: true,
      createdAt: Date.now(),
      used: 0,
      granted: 0,
    };
    this.items.set(p.id, p);
    this.persist(p);
    this.log.log(`новий промокод ${p.code}: +${p.percent}%`);
    return p;
  }

  update(id: string, patch: { percent?: number; active?: boolean }): PromoCode {
    const p = this.items.get(id);
    if (!p) throw new NotFoundException('Промокод не найден');
    if (patch.percent !== undefined) {
      if (!Number.isFinite(patch.percent) || patch.percent <= 0
        || patch.percent > PROMO_MAX_PERCENT) {
        throw new BadRequestException(`Процент должен быть от 1 до ${PROMO_MAX_PERCENT}`);
      }
      p.percent = Math.round(patch.percent);
    }
    if (patch.active !== undefined) p.active = patch.active;
    this.persist(p);
    return p;
  }

  remove(id: string): void {
    if (!this.items.delete(id)) throw new NotFoundException('Промокод не найден');
    this.store?.remove(id).catch((e: unknown) =>
      this.log.error(`промокод ${id} не видалився: ${(e as Error).message}`));
  }

  /* ---- гра ---- */

  private find(code: string): PromoCode | undefined {
    return [...this.items.values()].find((p) => p.code === code);
  }

  /* Скільки відсотків дає цей код ПРЯМО ЗАРАЗ.

     Кидає, а не повертає нуль: гравець ввів код свідомо, і мовчки
     створити заявку без надбавки означало б забрати в нього гроші, про
     які він домовлявся. Хай краще виправить друкарську помилку до
     переказу, ніж прийде зі скаргою після.

     Порожній рядок — це «коду немає», і це не помилка: поле
     необов'язкове. */
  percentFor(rawCode: string | undefined): { code: string; percent: number } | null {
    if (!rawCode || !rawCode.trim()) return null;
    const code = normalizeCode(rawCode);
    if (code.length > PROMO_CODE_MAX) throw new BadRequestException('Промокод не найден');

    const p = this.find(code);
    /* Вимкнений код відповідає так само, як неіснуючий. Інакше CRM
       мимоволі стає довідником: «код є, але вимкнений» — це вже
       підказка тому, хто перебирає чужі коди. */
    if (!p || !p.active) throw new BadRequestException('Промокод не найден');
    return { code: p.code, percent: p.percent };
  }

  /* Нарахувати надбавку за погодженою заявкою.

     percent береться З ЗАЯВКИ, а не з поточного стану коду: заявка
     заморозила обіцянку в момент створення (див. promo.types). Тому тут
     код шукають лише заради лічильників, і його відсутність нарахуванню
     не заважає — гравець не винен, що адмін видалив код, поки переказ
     ішов мережею.

     Повертає нараховану суму (0 — нічого не нараховано). */
  grant(telegramId: number, deposit: number, code: string | undefined,
        percent: number | undefined): number {
    if (!code || !percent || percent <= 0 || deposit <= 0) return 0;

    const rub = Math.round(deposit * percent / 100);
    if (rub <= 0) return 0;

    this.players.grantBonus(telegramId, rub, PROMO_WAGER_X, `промокод ${code}`);

    const p = this.find(normalizeCode(code));
    if (p) {
      p.used += 1;
      p.granted += rub;
      this.persist(p);
    }
    this.log.log(`промокод ${code}: ${telegramId} +${rub}₽ бонусом (${percent}% від ${deposit})`);
    return rub;
  }
}
