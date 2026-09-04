import 'reflect-metadata';
import { resolve } from 'node:path';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ENV, type Env } from './config/env';

/* .env лежить у корені монорепо — один файл на всі застосунки.
   Читаємо його ДО створення застосунку, бо loadEnv() перевіряє
   TELEGRAM_BOT_TOKEN уже на етапі побудови модулів.
   Без залежностей: process.loadEnvFile є в Node 20.12+. */
for (const p of ['../../.env', '.env']) {
  try {
    process.loadEnvFile(resolve(process.cwd(), p));
    break;
  } catch { /* немає файлу — працюємо на змінних оточення */ }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const env = app.get<Env>(ENV);
  const log = new Logger('Minedrop');

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    // query-параметри приходять рядками, а в DTO вони числа
    transformOptions: { enableImplicitConversion: true },
  }));

  /* У проді фронт і API стоять на одному домені (Next проксює /api),
     тому CORS там не потрібен зовсім. Список лишається для dev,
     де Next на :3000, а Nest на :4000. */
  app.enableCors({ origin: env.webOrigins, credentials: true });

  await app.listen(env.port);
  log.log(`API на http://localhost:${env.port}/api`);

  if (env.devAuth) {
    log.warn('==================================================');
    log.warn(env.botToken
      ? ' DEV-АВТОРИЗАЦІЯ увімкнена через DEV_AUTH=true.'
      : ' DEV-АВТОРИЗАЦІЯ: TELEGRAM_BOT_TOKEN не заданий.');
    log.warn(' Запит БЕЗ заголовка Authorization пускається як');
    log.warn(' гравець із x-dev-user (за замовчуванням 1).');
    if (env.botToken) {
      log.warn(' Запит З initData перевіряється по-справжньому —');
      log.warn(' підроблений підпис отримає 401 і тут.');
    }
    log.warn(' У продакшні ця гілка недосяжна за побудовою.');
    log.warn('==================================================');
  }
}

void bootstrap();
