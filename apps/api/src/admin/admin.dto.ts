import { IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/* Тіла запитів CRM. */

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
