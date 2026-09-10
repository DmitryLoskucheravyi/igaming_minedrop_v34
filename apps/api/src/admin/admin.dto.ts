import {
  ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString,
  Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { NETWORKS, TOKENS, type Family, type NetworkId, type TokenId } from '../payments/networks';
import type { DepositMode } from '../settings/settings.types';

/* Тіла запитів CRM. Лежать окремо від контролерів, бо RejectDto
   потрібен одразу трьом («відхилити депозит», «відхилити вивід»,
   «ігнорувати неопізнаний»), і копіювати його втретє означало б знову
   отримати три версії однієї перевірки. */

export class LoginDto {
  @IsString() @MinLength(1) @MaxLength(120)
  login!: string;

  @IsString() @MinLength(1) @MaxLength(200)
  password!: string;
}

export class RefreshDto {
  @IsString() @MinLength(32) @MaxLength(200)
  refresh!: string;
}

export class TopUpDto {
  @IsInt() @Min(1) @Max(100_000_000)
  amount!: number;
}

export class RejectDto {
  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class AddAddressDto {
  /* Родина, а не мережа: 0x-адреса обслуговує всі EVM-мережі одразу,
     тож заводити її шість разів було б безглуздо. */
  @IsIn(['evm', 'tron', 'ton', 'solana'])
  family!: Family;

  @IsString() @MaxLength(80)
  address!: string;

  @IsOptional() @IsString() @MaxLength(60)
  label?: string;
}

export class PatchAddressDto {
  @IsOptional() @IsString() @MaxLength(60)
  label?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;
}

export class CreditUnmatchedDto {
  @IsInt()
  telegramId!: number;

  /* Не задали — порахуємо за поточним курсом. Задали — віримо адміну:
     курсу на момент того переказу ми не знаємо. */
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000)
  rub?: number;
}

export class DepositSettingsDto {
  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsIn(['off', 'watch', 'semi', 'auto'])
  mode?: DepositMode;

  @IsOptional() @IsArray() @ArrayUnique() @IsIn(Object.keys(NETWORKS), { each: true })
  networks?: NetworkId[];

  @IsOptional() @IsArray() @ArrayUnique() @IsIn(Object.keys(TOKENS), { each: true })
  tokens?: TokenId[];
}

export class WatcherDto {
  @IsBoolean()
  enabled!: boolean;
}

export class SimulateDto {
  /* Сума не обов'язкова: без неї симулюється РІВНО те, що просили в
     заявці. Задав — перевіряєш недоплату чи переплату, не створюючи
     нової заявки. */
  @IsOptional() @IsNumber() @Min(0.000001)
  amount?: number;
}
