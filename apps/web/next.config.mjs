import { resolve } from 'node:path';

/* Next читає .env зі своєї теки, а в нас він один на монорепо —
   у корені. Підвантажуємо його вручну, щоб не тримати дві копії. */
try {
  process.loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch { /* немає файлу — беремо значення за замовчуванням */ }

/** @type {import('next').NextConfig} */

/* API за замовчуванням проксюється через сам Next: /api/* -> Nest.

   Це не косметика. У вебв'ю телеграма запити на інший домен —
   це третя сторона з усіма її обмеженнями (куки, CORS, приватні
   режими iOS). Коли фронт і API на одному origin, цієї категорії
   проблем не існує взагалі.

   API_ORIGIN — куди проксювати (dev: localhost:4000).
   NEXT_PUBLIC_API_URL можна задати явно, якщо API стоїть окремо. */
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  // рушій лежить у монорепо як окремий пакет
  transpilePackages: ['@minedrop/engine'],

  /* У dev Next блокує запити ассетів із чужого хоста. Через тунель
     хост саме чужий (не localhost), тому мініапс у телеграмі не
     завантажився б. На прод-збірку це не впливає. */
  allowedDevOrigins: ['*.trycloudflare.com', '*.ts.net', '*.ngrok-free.app', '*.loca.lt'],

  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },

  async headers() {
    return [{
      source: '/:path*',
      headers: [
        // мініапс відкривається в iframe телеграма
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    }, {
      // скіни не міняються — хай лежать у кеші, це найважчий трафік
      source: '/assets/:path*',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    }];
  },
};

export default nextConfig;
