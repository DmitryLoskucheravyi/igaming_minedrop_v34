import {
  Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ENV, type Env } from '../config/env';
import { PlayersService } from '../players/players.service';
import { PaymentsService } from '../payments/payments.service';

/* ============================================================
   ADMIN — тимчасова панель на час тестів. БЕЗ авторизації, тому
   доступна ТІЛЬКИ поза продакшном (loadEnv().isProd === false).
   Гравці + ручне поповнення + заявки на депозит.
   ============================================================ */

class TopUpDto {
  @IsInt() @Min(1) @Max(100_000_000)
  amount!: number;
}

class RejectDto {
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

class AddAddressDto {
  @IsString() @MaxLength(64)
  address!: string;

  @IsOptional() @IsString() @MaxLength(60)
  label?: string;
}

class PatchAddressDto {
  @IsOptional() @IsString() @MaxLength(60)
  label?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly players: PlayersService,
    private readonly payments: PaymentsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private guard(): void {
    if (this.env.isProd) {
      throw new ForbiddenException('Админ-панель недоступна в продакшне');
    }
  }

  /** Усі гравці, свіжіші зверху. */
  @Get('players')
  list() {
    this.guard();
    const players = this.players.all()
      .sort((a, b) => b.seenAt - a.seenAt)
      .map((r) => ({
        telegramId: r.telegramId,
        firstName: r.firstName,
        username: r.username ?? null,
        balance: r.balance,
        nonce: r.nonce,
        // найдовша серія до гарантії серед усіх ставок гравця
        dryStreak: Math.max(0, ...Object.values(r.dryStreaks)),
        createdAt: r.createdAt,
        seenAt: r.seenAt,
      }));
    return { players, count: players.length };
  }

  /** Поповнити баланс гравця на amount (рублів). */
  @Post('players/:id/topup')
  topUp(@Param('id') id: string, @Body() dto: TopUpDto) {
    this.guard();
    const balance = this.players.topUp(Number(id), dto.amount);
    if (balance === null) throw new NotFoundException('Игрок не найден');
    return { telegramId: Number(id), balance, added: dto.amount };
  }

  /* ---- заявки на депозит ---- */

  /** Усі заявки: pending зверху. Плюс ім'я/нік гравця й заголовок адреси. */
  @Get('payments')
  payList() {
    this.guard();
    const addrById = new Map(this.payments.addrList().map((a) => [a.id, a]));
    const payments = this.payments.listAll().map((p) => {
      const pl = this.players.byId(p.telegramId);
      const a = p.addressId ? addrById.get(p.addressId) : undefined;
      return {
        ...p,
        addressLabel: a?.label ?? null,
        player: pl
          ? { firstName: pl.firstName, username: pl.username ?? null, balance: pl.balance }
          : null,
      };
    });
    const pending = payments.filter((p) => p.status === 'pending').length;
    return { payments, count: payments.length, pending };
  }

  @Post('payments/:id/approve')
  payApprove(@Param('id') id: string) {
    this.guard();
    return this.payments.approve(id);
  }

  @Post('payments/:id/reject')
  payReject(@Param('id') id: string, @Body() dto: RejectDto) {
    this.guard();
    return this.payments.reject(id, dto.note);
  }

  /* ---- адреси для прийому ---- */

  @Get('addresses')
  addrList() {
    this.guard();
    const busy = new Map<string, number>();
    for (const p of this.payments.listAll()) {
      if (p.status === 'pending' && p.addressId) busy.set(p.addressId, (busy.get(p.addressId) ?? 0) + 1);
    }
    return {
      addresses: this.payments.addrList().map((a) => ({ ...a, pending: busy.get(a.id) ?? 0 })),
    };
  }

  @Post('addresses')
  addrAdd(@Body() dto: AddAddressDto) {
    this.guard();
    return this.payments.addAddress(dto.address, dto.label);
  }

  @Post('addresses/:id')
  addrPatch(@Param('id') id: string, @Body() dto: PatchAddressDto) {
    this.guard();
    return this.payments.updateAddress(id, dto);
  }

  @Post('addresses/:id/delete')
  addrDelete(@Param('id') id: string) {
    this.guard();
    this.payments.removeAddress(id);
    return { ok: true };
  }
}
