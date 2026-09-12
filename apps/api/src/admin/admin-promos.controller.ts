import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PromosService } from '../promos/promos.service';
import { PROMO_MAX_PERCENT, PROMO_WAGER_X } from '../promos/promo.types';
import { AdminAuthGuard } from './admin-auth.guard';
import { AddPromoDto, PatchPromoDto } from './admin.dto';

/* ============================================================
   ВКЛАДКА «ПРОМОКОДЫ».

   Код + відсоток надбавки до поповнення, і все. Свідомо мало полів:
   кожна додаткова умова (термін дії, ліміт застосувань, мінімальна
   сума) — це ще одна причина, з якої гравцеві скажуть «промокод не
   подходит», і ще одне місце, де адмін може її не помітити.

   Разом зі списком віддаємо wagerX і стелю відсотка: CRM не має
   тримати власну копію правил, які живуть на сервері.
   ============================================================ */

@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminPromosController {
  constructor(private readonly promos: PromosService) {}

  @Get('promos')
  list() {
    return {
      promos: this.promos.list(),
      /* Скільки разів треба прокрутити надбавку. Адмін мусить це
         бачити: він обіцяє гравцям відсоток, а отримують вони його з
         умовою. */
      wagerX: PROMO_WAGER_X,
      maxPercent: PROMO_MAX_PERCENT,
    };
  }

  @Post('promos')
  add(@Body() dto: AddPromoDto) {
    return this.promos.add(dto.code, dto.percent);
  }

  @Post('promos/:id')
  patch(@Param('id') id: string, @Body() dto: PatchPromoDto) {
    return this.promos.update(id, dto);
  }

  /* Видалення, а не лише вимкнення: вимкнений код лишається в списку й
     заважає завести такий самий наново, а це буває потрібно. На вже
     створені заявки видалення не впливає — відсоток у них заморожений
     (див. promo.types). */
  @Post('promos/:id/delete')
  remove(@Param('id') id: string) {
    this.promos.remove(id);
    return { ok: true };
  }
}
