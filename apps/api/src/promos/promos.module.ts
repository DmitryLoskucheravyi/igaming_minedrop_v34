import { Module } from '@nestjs/common';
import { PlayersModule } from '../players/players.module';
import { PromosService } from './promos.service';

/* Промокоди потрібні двом: платежам (перевірити код на заявці,
   нарахувати надбавку після погодження) і CRM (завести й вимкнути).
   Тому це окремий модуль, а не частина платежів — інакше адмінка
   тягнула б за собою весь механізм заявок заради одного списку. */
@Module({
  imports: [PlayersModule],
  providers: [PromosService],
  exports: [PromosService],
})
export class PromosModule {}
