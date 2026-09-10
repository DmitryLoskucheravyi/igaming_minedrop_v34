import {
  Body, Controller, Get, HttpException, HttpStatus, Param, Post, UseGuards,
} from '@nestjs/common';
import { PaymentRequests } from '../payments/payment-requests.service';
import { DepositAddressPool } from '../payments/deposit-addresses.service';
import { SettingsService } from '../settings/settings.service';
import { WatcherService } from '../watcher/watcher.service';
import { FAMILY_HINT, TOKENS, networkList, type TokenId } from '../payments/networks';
import { AdminAuthGuard } from './admin-auth.guard';
import {
  AddAddressDto, DepositSettingsDto, PatchAddressDto, SimulateDto, WatcherDto,
} from './admin.dto';

/* ============================================================
   ВКЛАДКА «ДЕПОЗИТЫ» — чим і як приймаємо гроші.

   Адреси прийому, режим довіри боту, рубильник слухача. Усе разом, бо
   порізно ці налаштування безглузді: увімкнена мережа без адреси своєї
   родини — це помилка в момент переказу гравця, і побачити її треба
   тут, а не з його скарги.
   ============================================================ */

@Controller('admin')
@UseGuards(AdminAuthGuard)
export class AdminDepositsController {
  constructor(
    private readonly payments: PaymentRequests,
    private readonly addresses: DepositAddressPool,
    private readonly settings: SettingsService,
    private readonly watcher: WatcherService,
  ) {}

  /* Скільки заявок висить на кожній адресі — щоб адмін бачив, яку з
     них зараз навантажено, перш ніж вимикати. */
  private addressesWithLoad() {
    const busy = this.payments.busyByAddress();
    return this.addresses.list().map((a) => ({ ...a, pending: busy.get(a.id) ?? 0 }));
  }

  /* ---- адреси прийому ---- */

  @Get('addresses')
  addrList() {
    return { addresses: this.addressesWithLoad() };
  }

  @Post('addresses')
  addrAdd(@Body() dto: AddAddressDto) {
    return this.addresses.add(dto.family, dto.address, dto.label);
  }

  @Post('addresses/:id')
  addrPatch(@Param('id') id: string, @Body() dto: PatchAddressDto) {
    return this.addresses.update(id, dto);
  }

  @Post('addresses/:id/delete')
  addrDelete(@Param('id') id: string) {
    this.addresses.remove(id);
    return { ok: true };
  }

  /* ---- налаштування прийому ----

     Одним запитом усе, з чого складається вкладка: режим, каталог
     мереж, монети, адреси й те, що бот слухає прямо зараз. Каталог
     віддаємо з сервера, щоб CRM не тримала власної копії списку, яка
     розійшлася б при додаванні мережі.

     watching рахує ТОЙ САМИЙ метод, який читатиме спостерігач, тому в
     CRM видно не переказ наміру, а буквально його робочий список. */
  @Get('deposit-settings')
  depSettings() {
    return {
      settings: this.settings.getDeposits(),
      addresses: this.addressesWithLoad(),
      watching: this.addresses.watchTargets(),
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
  watcherStatus() {
    return this.watcher.status();
  }

  @Post('watcher')
  async watcherToggle(@Body() dto: WatcherDto) {
    await this.settings.setDeposits({ enabled: dto.enabled });
    return this.watcher.status();
  }

  /* Позачерговий обхід. Потрібен рівно там, де чекати наступного циклу
     незручно: гравець на лінії каже «я переказав», і треба подивитись
     зараз, а не через двадцять секунд. */
  @Post('watcher/run')
  watcherRun() {
    return this.watcher.runNow();
  }

  /* Підробити переказ, щоб перевірити ланцюжок без реальних грошей.

     Тільки поза продакшном — це стереже сам WatcherService, і стереже
     не налаштуванням, а NODE_ENV. Тут лишається перекласти його відмову
     в 403, щоб CRM показала зрозуміле, а не «500». */
  @Post('payments/:id/simulate')
  simulate(@Param('id') id: string, @Body() dto: SimulateDto) {
    try {
      return this.watcher.simulate(id, dto.amount);
    } catch (e) {
      throw new HttpException((e as Error).message, HttpStatus.FORBIDDEN);
    }
  }
}
