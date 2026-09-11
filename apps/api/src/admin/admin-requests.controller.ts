import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { PlayersService } from '../players/players.service';
import { PaymentRequests } from '../payments/payment-requests.service';
import { DepositAddressPool } from '../payments/deposit-addresses.service';
import { UnmatchedRegistry } from '../payments/unmatched.service';
import { WithdrawService } from '../withdrawals/withdraw.service';
import { NETWORKS } from '../payments/networks';
import { AdminAuthGuard } from './admin-auth.guard';
import { CreditUnmatchedDto, RejectDto } from './admin.dto';

/* ============================================================
   ВКЛАДКА «ЗАЯВКИ» — усе, де від адміна чекають рішення.

   Три списки поруч навмисно: депозити, виводи й неопізнані перекази —
   це один робочий стіл. Гроші, які прийшли не туди, розбирають тим
   самим поглядом, що й заявку, яка не зійшлася.

   Контролер лише збирає відповідь і приєднує гравця; жодного рішення
   про гроші тут немає — воно все в сервісах платежів.
   ============================================================ */

@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminRequestsController {
  constructor(
    private readonly players: PlayersService,
    private readonly payments: PaymentRequests,
    private readonly addresses: DepositAddressPool,
    private readonly unmatched: UnmatchedRegistry,
    private readonly withdraw: WithdrawService,
  ) {}

  /** Ім'я, нік і баланс гравця — приєднуємо до кожного рядка. */
  private playerOf(telegramId: number) {
    const pl = this.players.byId(telegramId);
    return pl
      ? {
        firstName: pl.firstName, username: pl.username ?? null,
        balance: (pl.cash ?? 0) + (pl.bonus ?? 0),
      }
      : null;
  }

  /* ---- депозити ---- */

  /** Усі заявки: pending зверху. Плюс ім'я/нік гравця й заголовок адреси. */
  @Get('payments')
  payList() {
    const payments = this.payments.listAll().map((p) => ({
      ...p,
      addressLabel: this.addresses.labelOf(p.addressId),
      player: this.playerOf(p.telegramId),
    }));
    /* У лічильнику для бейджа і те, що бот уже знайшов: це рівно ті
       заявки, де від адміна щось потрібно або ось-ось знадобиться. */
    const pending = payments.filter(
      (p) => p.status === 'pending' || p.status === 'processing').length;
    return { payments, count: payments.length, pending };
  }

  @Post('payments/:id/approve')
  payApprove(@Param('id') id: string) {
    return this.payments.approve(id);
  }

  @Post('payments/:id/reject')
  payReject(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.payments.reject(id, dto.note);
  }

  /* ---- виведення ---- */

  /** Усі виводи: pending зверху, з ім'ям гравця й адресою, КУДИ слати. */
  @Get('withdrawals')
  wdList() {
    const rows = this.withdraw.listAll().map((w) => ({
      ...w,
      player: this.playerOf(w.telegramId),
    }));
    return {
      withdrawals: rows,
      count: rows.length,
      pending: rows.filter((w) => w.status === 'pending').length,
    };
  }

  /** Кошти відправлено. Баланс не чіпається — його списано ще при заявці. */
  @Post('withdrawals/:id/approve')
  wdApprove(@Param('id') id: string) {
    return this.withdraw.approve(id);
  }

  /** Відмова. Гроші повертаються гравцю на баланс. */
  @Post('withdrawals/:id/reject')
  wdReject(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.withdraw.reject(id, dto.note);
  }

  /* ---- неопізнані платежі ----

     Переказ прийшов, але не зіставився з заявкою. Гроші вже в нас, тож
     рядок не зникає, доки адмін не вирішить, що з ним робити. */

  @Get('unmatched')
  unmatchedList() {
    const rows = this.unmatched.list().map((u) => ({
      ...u,
      networkName: NETWORKS[u.network]?.name ?? u.network,
      player: u.creditedTo ? this.players.byId(u.creditedTo)?.firstName ?? null : null,
    }));
    return {
      unmatched: rows,
      count: rows.length,
      fresh: rows.filter((u) => u.status === 'new').length,
    };
  }

  @Post('unmatched/:id/credit')
  unmatchedCredit(@Param('id') id: string, @Body() dto: CreditUnmatchedDto) {
    return this.unmatched.credit(id, dto.telegramId, dto.rub);
  }

  @Post('unmatched/:id/ignore')
  unmatchedIgnore(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.unmatched.ignore(id, dto.note);
  }
}
