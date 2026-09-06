import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Bot } from 'grammy';
import { ENV, type Env } from '../config/env';

/* ============================================================
   BOT — сам телеграм-бот. Його завдання мінімальне: дати кнопку,
   яка відкриває мініапс. Уся гра живе в мініапсі, бот нічого не
   рахує і грошей не бачить.

   Режими:
     - dev: long polling, нічого налаштовувати не треба;
     - прод: вебхук, якщо задано TELEGRAM_WEBHOOK_URL.

   Без токена сервіс просто не піднімається — API далі працює,
   бо в dev мініапс відкривається і зі звичайного браузера.
   ============================================================ */

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BotService.name);
  private bot: Bot | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async onModuleInit(): Promise<void> {
    /* Бот не має права покласти API.

       Він тільки дає кнопку запуску; гра живе в мініапсі. Якщо
       телеграм недоступний під час деплою або токен протух, сервер
       мусить піднятись і обслуговувати тих, у кого мініапс уже
       відкритий, — а не впасти на старті через 401 від deleteWebhook.

       Підпис initData від цього не залежить: він рахується локально
       з токена, без жодного запиту до телеграма. */
    try {
      await this.start();
    } catch (e) {
      this.bot = null;
      this.log.error(`Бот не піднявся: ${(e as Error).message}`);
      this.log.error('API працює далі. Перевір TELEGRAM_BOT_TOKEN і доступність api.telegram.org.');
    }
  }

  private async start(): Promise<void> {
    const { botToken, webAppUrl } = this.env;

    if (!botToken) {
      this.log.warn('TELEGRAM_BOT_TOKEN не заданий — бот не піднімається. ' +
        'Гра відкривається у браузері, авторизація в dev-режимі (x-dev-user).');
      return;
    }
    if (!webAppUrl) {
      this.log.warn('WEBAPP_URL не заданий — кнопка запуску мініапса буде без адреси. ' +
        'Постав https-адресу фронта.');
    }

    const bot = new Bot(botToken);
    this.bot = bot;

    bot.command('start', async (ctx) => {
      if (!webAppUrl) {
        await ctx.reply('Мини-апп ещё не настроен: не задан WEBAPP_URL.');
        return;
      }
      await ctx.reply('Кирка ждёт. Жми — и в шахту.', {
        reply_markup: {
          inline_keyboard: [[{ text: '⛏ ИГРАТЬ', web_app: { url: webAppUrl } }]],
        },
      });
    });

    bot.catch((err) => this.log.error(`Помилка бота: ${err.message}`));

    /* Кнопка біля поля вводу — щоб мініапс відкривався не тільки з /start */
    if (webAppUrl) {
      try {
        await bot.api.setChatMenuButton({
          menu_button: { type: 'web_app', text: 'Играть', web_app: { url: webAppUrl } },
        });
      } catch (e) {
        this.log.warn(`Не вдалось поставити menu button: ${(e as Error).message}`);
      }
    }

    if (this.env.webhookUrl) {
      await bot.api.setWebhook(this.env.webhookUrl, {
        secret_token: this.env.webhookSecret ?? undefined,
      });
      await bot.init();
      this.log.log(`Бот @${bot.botInfo.username} на вебхуку ${this.env.webhookUrl}`);
    } else {
      /* start() не резолвиться, поки бот працює, тому без await.
         Але й без catch не можна: падіння полінгу інакше стає
         unhandled rejection і кладе процес. */
      await bot.init();
      void bot.start({
        onStart: (info) => this.log.log(`Бот @${info.username} на long polling`),
      }).catch((e: Error) => {
        this.log.error(`Long polling зупинився: ${e.message}. API працює далі.`);
      });
    }
  }

  /** Обробник апдейта з вебхука (див. TelegramController) */
  async handleUpdate(update: unknown, secret?: string): Promise<boolean> {
    if (!this.bot) return false;
    if (this.env.webhookSecret && secret !== this.env.webhookSecret) return false;
    await this.bot.handleUpdate(update as Parameters<Bot['handleUpdate']>[0]);
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.bot?.stop().catch(() => undefined);
  }
}
