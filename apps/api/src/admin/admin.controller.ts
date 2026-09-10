import {
  Body, Controller, Get, HttpCode, HttpException, HttpStatus,
  NotFoundException, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import {
  ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString,
  Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { PlayersService } from '../players/players.service';
import { PaymentsService } from '../payments/payments.service';
import {
  FAMILY_HINT, NETWORKS, TOKENS, networkList,
  type Family, type NetworkId, type TokenId,
} from '../payments/networks';
import { SettingsService } from '../settings/settings.service';
import type { DepositMode } from '../settings/settings.types';
import { WithdrawService } from '../withdrawals/withdraw.service';
import { WatcherService } from '../watcher/watcher.service';
import { RateLimiter, clientKey } from '../common/rate-limit';

/* Обмін токенів відкритий назовні, тому має свій ліміт. 60 на хвилину —
   з великим запасом для живого клієнта (він міняє раз на 15 хвилин) і
   мало для перебору. REFRESH_GLOBAL — той самий спільний рубіж, що й
   LOGIN_GLOBAL/VERIFY_GLOBAL: per-ключовий лічильник довіряє clientKey,
   а це останній рівень страховки на випадок, якщо довіра до проксі
   колись стане іншою. */
const REFRESH_LIMIT = new RateLimiter(60, 60_000);
const REFRESH_GLOBAL = new RateLimiter(300, 60_000);
import { AdminsService } from './admins.service';
import { AdminAuthGuard, CurrentAdmin, bearerFrom, type AdminRequest } from './admin-auth.guard';
import type { AdminSession } from './admin.types';

/* ============================================================
   ADMIN — CRM: гравці, ручне поповнення, заявки на депозит, адреси.

   Доступ — тільки під обліковим записом адміна (колекція `admins`,
   див. admins.service.ts). Публічний тут рівно один маршрут — вхід.

   Було: єдиною перепоною стояло `if (isProd) throw` — тобто поза
   продом CRM була відкрита будь-кому, хто знає адресу, включно з
   публічним тунелем із `npm run tg`.
   ============================================================ */

class LoginDto {
  @IsString() @MinLength(1) @MaxLength(120)
  login!: string;

  @IsString() @MinLength(1) @MaxLength(200)
  password!: string;
}

class RefreshDto {
  @IsString() @MinLength(32) @MaxLength(200)
  refresh!: string;
}

class TopUpDto {
  @IsInt() @Min(1) @Max(100_000_000)
  amount!: number;
}

class RejectDto {
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

class AddAddressDto {
  /* Родина, а не мережа: 0x-адреса обслуговує всі EVM-мережі одразу,
     тож заводити її шість разів було б безглуздо. */
  @IsIn(['evm', 'tron', 'ton', 'solana'])
  family!: Family;

  @IsString() @MaxLength(80)
  address!: string;

  @IsOptional() @IsString() @MaxLength(60)
  label?: string;
}

class CreditUnmatchedDto {
  @IsInt()
  telegramId!: number;

  /* Не задали — порахуємо за поточним курсом. Задали — віримо адміну:
     курсу на момент того переказу ми не знаємо. */
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000)
  rub?: number;
}

class DepositSettingsDto {
  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsIn(['off', 'watch', 'semi', 'auto'])
  mode?: DepositMode;

  @IsOptional() @IsArray() @ArrayUnique() @IsIn(Object.keys(NETWORKS), { each: true })
  networks?: NetworkId[];

  @IsOptional() @IsArray() @ArrayUnique() @IsIn(Object.keys(TOKENS), { each: true })
  tokens?: TokenId[];
}

class WatcherDto {
  @IsBoolean()
  enabled!: boolean;
}

class SimulateDto {
  /* Сума не обов'язкова: без неї симулюється РІВНО те, що просили в
     заявці. Задав — перевіряєш недоплату чи переплату, не створюючи
     нової заявки. */
  @IsOptional() @IsNumber() @Min(0.000001)
  amount?: number;
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
    private readonly withdraw: WithdrawService,
    private readonly admins: AdminsService,
    private readonly settings: SettingsService,
    private readonly watcher: WatcherService,
  ) {}

  /* ---- вхід ---- */

  /** Єдиний маршрут CRM без токена. Лічильник спроб — в AdminsService. */
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: AdminRequest) {
    return this.admins.login(dto.login, dto.password, clientKey(req.headers, req.ip));
  }

  /* Обмін refresh на нову пару. Публічний, як і вхід: access тут за
     побудовою вже протух, тож гардом його не перевіриш. Ліміт частоти
     обов'язковий — маршрут відкритий. */
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() req: AdminRequest) {
    const key = clientKey(req.headers, req.ip);
    if (!REFRESH_LIMIT.take(key) || !REFRESH_GLOBAL.take('all')) {
      throw new HttpException(
        `Слишком часто. Попробуй через ${REFRESH_LIMIT.retryAfterSec(key)} с`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.admins.refresh(dto.refresh);
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(AdminAuthGuard)
  logout(@Req() req: AdminRequest) {
    const token = bearerFrom(req.headers);
    if (token) this.admins.logout(token);
    return { ok: true };
  }

  /** Хто зайшов + до якого часу жива сесія. Фронт кличе на старті,
      щоб зрозуміти, показувати форму входу чи вже саму CRM. */
  @Get('me')
  @UseGuards(AdminAuthGuard)
  me(@CurrentAdmin() session: AdminSession) {
    return { admin: this.admins.view(session.adminId), expiresAt: session.expiresAt };
  }

  /* ---- гравці ---- */

  /** Усі гравці, свіжіші зверху. */
  @Get('players')
  @UseGuards(AdminAuthGuard)
  list() {
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
  @UseGuards(AdminAuthGuard)
  topUp(@Param('id') id: string, @Body() dto: TopUpDto, @CurrentAdmin() session: AdminSession) {
    const telegramId = Number(id);
    if (!Number.isInteger(telegramId)) throw new NotFoundException('Игрок не найден');
    const balance = this.players.topUp(telegramId, dto.amount, session.login);
    if (balance === null) throw new NotFoundException('Игрок не найден');
    return { telegramId, balance, added: dto.amount };
  }

  /* Обнулити баланс.

     Окремо від поповнення й з іншим підтвердженням у CRM: поповнення
     помилкою на нуль не зробиш, а обнулення — необоротне. Повертаємо
     СКІЛЬКИ зняли, щоб адмін бачив, що саме щойно сталося, а не лише
     новий нуль. */
  @Post('players/:id/zero')
  @UseGuards(AdminAuthGuard)
  zeroBalance(@Param('id') id: string, @CurrentAdmin() session: AdminSession) {
    const telegramId = Number(id);
    if (!Number.isInteger(telegramId)) throw new NotFoundException('Игрок не найден');
    const res = this.players.zeroBalance(telegramId, session.login);
    if (!res) throw new NotFoundException('Игрок не найден');
    return { telegramId, balance: res.balance, taken: res.taken };
  }

  /* Видалити гравця НАЗАВЖДИ.

     Заявки на депозит і виведення при цьому лишаються: за ними потім
     і розбирають, куди пішли гроші, і зачищати їх разом із гравцем
     означало б втратити слід платежу. */
  @Post('players/:id/delete')
  @UseGuards(AdminAuthGuard)
  removePlayer(@Param('id') id: string, @CurrentAdmin() session: AdminSession) {
    const telegramId = Number(id);
    if (!Number.isInteger(telegramId)) throw new NotFoundException('Игрок не найден');
    if (!this.players.remove(telegramId, session.login)) {
      throw new NotFoundException('Игрок не найден');
    }
    return { telegramId, deleted: true };
  }

  /* ---- заявки на депозит ---- */

  /** Усі заявки: pending зверху. Плюс ім'я/нік гравця й заголовок адреси. */
  @Get('payments')
  @UseGuards(AdminAuthGuard)
  payList() {
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
    /* У лічильнику для бейджа і те, що бот уже знайшов: це рівно ті
       заявки, де від адміна щось потрібно або ось-ось знадобиться. */
    const pending = payments.filter(
      (p) => p.status === 'pending' || p.status === 'processing').length;
    return { payments, count: payments.length, pending };
  }

  @Post('payments/:id/approve')
  @UseGuards(AdminAuthGuard)
  payApprove(@Param('id') id: string) {
    return this.payments.approve(id);
  }

  @Post('payments/:id/reject')
  @UseGuards(AdminAuthGuard)
  payReject(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.payments.reject(id, dto.note);
  }

  /* ---- заявки на виведення ---- */

  /** Усі виводи: pending зверху, з ім'ям гравця й адресою, КУДИ слати. */
  @Get('withdrawals')
  @UseGuards(AdminAuthGuard)
  wdList() {
    const rows = this.withdraw.listAll().map((w) => {
      const pl = this.players.byId(w.telegramId);
      return {
        ...w,
        player: pl
          ? { firstName: pl.firstName, username: pl.username ?? null, balance: pl.balance }
          : null,
      };
    });
    return { withdrawals: rows, count: rows.length,
             pending: rows.filter((w) => w.status === 'pending').length };
  }

  /** Кошти відправлено. Баланс не чіпається — його списано ще при заявці. */
  @Post('withdrawals/:id/approve')
  @UseGuards(AdminAuthGuard)
  wdApprove(@Param('id') id: string) {
    return this.withdraw.approve(id);
  }

  /** Відмова. Гроші повертаються гравцю на баланс. */
  @Post('withdrawals/:id/reject')
  @UseGuards(AdminAuthGuard)
  wdReject(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.withdraw.reject(id, dto.note);
  }

  /* ---- адреси для прийому ---- */

  @Get('addresses')
  @UseGuards(AdminAuthGuard)
  addrList() {
    const busy = new Map<string, number>();
    for (const p of this.payments.listAll()) {
      if (p.status === 'pending' && p.addressId) busy.set(p.addressId, (busy.get(p.addressId) ?? 0) + 1);
    }
    return {
      addresses: this.payments.addrList().map((a) => ({ ...a, pending: busy.get(a.id) ?? 0 })),
    };
  }

  @Post('addresses')
  @UseGuards(AdminAuthGuard)
  addrAdd(@Body() dto: AddAddressDto) {
    return this.payments.addAddress(dto.family, dto.address, dto.label);
  }

  @Post('addresses/:id')
  @UseGuards(AdminAuthGuard)
  addrPatch(@Param('id') id: string, @Body() dto: PatchAddressDto) {
    return this.payments.updateAddress(id, dto);
  }

  @Post('addresses/:id/delete')
  @UseGuards(AdminAuthGuard)
  addrDelete(@Param('id') id: string) {
    this.payments.removeAddress(id);
    return { ok: true };
  }

  /* ---- налаштування прийому ----

     Каталог мереж віддаємо разом із налаштуваннями: CRM малює
     перемикачі за ним і не тримає власної копії списку, яка б розійшлася
     з сервером при додаванні мережі. */

  /* Одним запитом усе, з чого складається вкладка «Депозиты → Крипто»:
     режим, каталог мереж, монети, адреси й те, що бот слухає прямо
     зараз. Разом, бо порізно вони безглузді: увімкнена мережа без
     адреси своєї родини — це помилка в момент переказу гравця, і
     побачити її треба тут, а не з його скарги.

     watching рахує ТОЙ САМИЙ метод, який читатиме спостерігач, тому в
     CRM видно не переказ наміру, а буквально його робочий список. */
  @Get('deposit-settings')
  @UseGuards(AdminAuthGuard)
  depSettings() {
    const busy = new Map<string, number>();
    for (const p of this.payments.listAll()) {
      if (p.status === 'pending' && p.addressId) busy.set(p.addressId, (busy.get(p.addressId) ?? 0) + 1);
    }
    return {
      settings: this.settings.getDeposits(),
      addresses: this.payments.addrList().map((a) => ({ ...a, pending: busy.get(a.id) ?? 0 })),
      watching: this.payments.watchTargets(),
      catalogue: {
        networks: networkList().map((n) => ({
          id: n.id, name: n.name, family: n.family, feeUsd: n.feeUsd,
          memo: !!n.memo, tokens: Object.keys(n.tokens) as TokenId[],
        })),
        tokens: Object.entries(TOKENS).map(([id, t]) => ({ id: id as TokenId, name: t.name })),
        familyHints: FAMILY_HINT,
      },
    };
  }

  @Post('deposit-settings')
  @UseGuards(AdminAuthGuard)
  async depSettingsSave(@Body() dto: DepositSettingsDto) {
    return { settings: await this.settings.setDeposits(dto) };
  }

  /* ---- слухач переказів ----

     Рубильник окремо від режиму й окремо від мереж, бо відповідає на
     інше питання: не «наскільки довіряємо боту», а «чи він узагалі
     зараз бігає в мережу».

     Вимкнути його безпечно: прийом грошей від цього не зупиняється.
     Гравці так само створюють заявки, перекази так само приходять —
     просто зіставляє їх адмін руками, як робив до появи бота. */

  @Get('watcher')
  @UseGuards(AdminAuthGuard)
  watcherStatus() {
    return this.watcher.status();
  }

  @Post('watcher')
  @UseGuards(AdminAuthGuard)
  async watcherToggle(@Body() dto: WatcherDto) {
    await this.settings.setDeposits({ enabled: dto.enabled });
    return this.watcher.status();
  }

  /* Позачерговий обхід. Потрібен рівно там, де чекати наступного циклу
     незручно: гравець на лінії каже «я переказав», і треба подивитись
     зараз, а не через двадцять секунд. */
  @Post('watcher/run')
  @UseGuards(AdminAuthGuard)
  watcherRun() {
    return this.watcher.runNow();
  }

  /* Підробити переказ, щоб перевірити ланцюжок без реальних грошей.

     Тільки поза продакшном — це стереже сам WatcherService, і стереже
     не налаштуванням, а NODE_ENV. Тут лишається перекласти його відмову
     в 403, щоб CRM показала зрозуміле, а не «500». */
  @Post('payments/:id/simulate')
  @UseGuards(AdminAuthGuard)
  simulate(@Param('id') id: string, @Body() dto: SimulateDto) {
    try {
      return this.watcher.simulate(id, dto.amount);
    } catch (e) {
      throw new HttpException((e as Error).message, HttpStatus.FORBIDDEN);
    }
  }

  /* ---- неопізнані платежі ----

     Переказ прийшов, але не зіставився з заявкою. Гроші вже в нас, тож
     рядок не зникає, доки адмін не вирішить, що з ним робити. */

  @Get('unmatched')
  @UseGuards(AdminAuthGuard)
  unmatchedList() {
    const rows = this.payments.unmatchedList().map((u) => ({
      ...u,
      networkName: NETWORKS[u.network]?.name ?? u.network,
      player: u.creditedTo ? this.players.byId(u.creditedTo)?.firstName ?? null : null,
    }));
    return { unmatched: rows, count: rows.length,
             fresh: rows.filter((u) => u.status === 'new').length };
  }

  @Post('unmatched/:id/credit')
  @UseGuards(AdminAuthGuard)
  unmatchedCredit(@Param('id') id: string, @Body() dto: CreditUnmatchedDto) {
    return this.payments.creditUnmatched(id, dto.telegramId, dto.rub);
  }

  @Post('unmatched/:id/ignore')
  @UseGuards(AdminAuthGuard)
  unmatchedIgnore(@Param('id') id: string, @Body() dto: RejectDto) {
    return this.payments.ignoreUnmatched(id, dto.note);
  }
}
