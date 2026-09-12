import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { PromosModule } from '../promos/promos.module';
import { PaymentStoreRef } from './payment-store.ref';
import { DepositAddressPool } from './deposit-addresses.service';
import { PaymentRequests } from './payment-requests.service';
import { UnmatchedRegistry } from './unmatched.service';
import { TransferMatcher } from './transfer-matcher.service';
import { PaymentsController } from './payments.controller';

/* Замість одного PaymentsService на 754 рядки — чотири сервіси за
   межами, які й так були видні по групах методів:

     PaymentStoreRef      одне підключення до сховища на всіх
     DepositAddressPool   адреси прийому й що слухає спостерігач
     PaymentRequests      життєвий цикл заявки: створити -> закрити
     UnmatchedRegistry    гроші прийшли, а заявки під них немає
     TransferMatcher      рішення про переказ: чия заявка й чи зараховувати

   Залежності спрямовані в один бік (matcher -> requests -> addresses),
   кільця немає жодного: щоб вибрати найменш завантажену адресу, пул
   отримує готову мапу зайнятості аргументом, а не інжектить заявки. */
@Module({
  imports: [PlayersModule, ReferralsModule, PromosModule],
  providers: [
    PaymentStoreRef,
    DepositAddressPool,
    PaymentRequests,
    UnmatchedRegistry,
    TransferMatcher,
  ],
  controllers: [PaymentsController],
  exports: [DepositAddressPool, PaymentRequests, UnmatchedRegistry, TransferMatcher],
})
export class PaymentsModule {}
