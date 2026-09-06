/* ============================================================
   ЗАПУСК МІНІАПСА В ТЕЛЕГРАМІ — однією командою.

       npm run tg                      # тунель cloudflared (нічого не треба)
       npm run tg -- --tunnel=tailscale # Tailscale Funnel (стала адреса)
       npm run tg -- --url=https://...  # свій домен, тунель не піднімати

   Що робить:
     1. піднімає публічний https-тунель на порт 3000;
     2. кладе отриману адресу у WEBAPP_URL в .env;
     3. запускає API і веб;
     4. каже, що натиснути в телеграмі.

   Порядок саме такий, бо бот читає WEBAPP_URL на старті — треба
   знати адресу ДО того, як він підніметься.
   ============================================================ */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(ROOT, '.env');
const PORT_WEB = 3000;
const IS_WIN = process.platform === 'win32';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const children = [];
let shuttingDown = false;

function run(cmd, argv, opts = {}) {
  const child = spawn(cmd, argv, {
    cwd: ROOT,
    shell: IS_WIN,          // на windows npm/бінарники — це .cmd
    ...opts,
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nзупиняю…');
  for (const c of children) {
    try { IS_WIN ? spawn('taskkill', ['/pid', String(c.pid), '/f', '/t']) : c.kill('SIGTERM'); }
    catch { /* уже помер */ }
  }
  setTimeout(() => process.exit(code), 800);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/* ---------- .env ---------- */

function setEnv(key, value) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : (text.trimEnd() + '\n' + line + '\n');
  writeFileSync(ENV_FILE, text, 'utf8');
}

function getEnv(key) {
  if (!existsSync(ENV_FILE)) return null;
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(ENV_FILE, 'utf8'));
  return m ? m[1].trim() : null;
}

/* ---------- тунелі ---------- */

/* Cloudflare quick tunnel: нічого не треба реєструвати, але адреса
   нова на кожен запуск. */
function cloudflared() {
  return new Promise((ok, fail) => {
    /* Беремо .exe напряму, а не шим із node_modules/.bin.
       Шлях до проєкту може містити пробіли («Нова папка»), і тоді
       запуск .cmd через шел ламається на неекранованому пробілі.
       З .exe і shell:false цієї проблеми немає взагалі. */
    let bin;
    try {
      bin = createRequire(import.meta.url)('cloudflared').bin;
    } catch {
      bin = resolve(ROOT, 'node_modules', 'cloudflared', 'bin',
        IS_WIN ? 'cloudflared.exe' : 'cloudflared');
    }
    if (!bin || !existsSync(bin)) {
      return fail(new Error('cloudflared не встановлений: npm i -D cloudflared'));
    }

    console.log('піднімаю тунель cloudflared…');
    const child = run(bin, ['tunnel', '--url', `http://localhost:${PORT_WEB}`],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false });

    let done = false;
    let tail = '';
    const look = (buf) => {
      const text = String(buf);
      tail = (tail + text).slice(-2000);          // на випадок помилки
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
      if (m && !done) { done = true; ok(m[0]); }
    };
    child.stdout.on('data', look);
    child.stderr.on('data', look);       // cloudflared пише адресу в stderr
    child.on('error', (e) => { if (!done) fail(new Error(`cloudflared не запустився: ${e.message}`)); });
    child.on('exit', (c) => {
      if (!done) fail(new Error(`cloudflared вийшов з кодом ${c}\n${tail.trim().slice(-600)}`));
    });
    setTimeout(() => { if (!done) fail(new Error('cloudflared не видав адресу за 45с')); }, 45000);
  });
}

/* Tailscale Funnel: адреса стала, але потрібен дозвіл у tailnet. */
async function tailscale() {
  const bin = IS_WIN ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
  const sh = (argv) => new Promise((ok) => {
    let out = '';
    const c = spawn(bin, argv, { shell: false });
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => ok({ code, out }));
    setTimeout(() => { try { c.kill(); } catch {} ok({ code: -1, out }); }, 30000);
  });

  const st = await sh(['status', '--json']);
  let host = null;
  try { host = JSON.parse(st.out)?.Self?.DNSName?.replace(/\.$/, '') || null; } catch { /* ignore */ }
  if (!host) throw new Error('не вдалось прочитати ім\'я машини в tailscale');

  console.log(`вмикаю Tailscale Funnel на ${host}…`);
  const fn = await sh(['funnel', '--bg', String(PORT_WEB)]);
  if (fn.code !== 0) {
    throw new Error(
      'Funnel не увімкнувся. Найчастіша причина — його не дозволено в tailnet.\n' +
      'Адмінка -> Access controls, додай у політику:\n' +
      '  "nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]\n' +
      'і увімкни HTTPS Certificates у DNS.\n' +
      `Вивід tailscale: ${fn.out.trim().slice(0, 400)}`);
  }
  return `https://${host}`;
}

/* ---------- головне ---------- */

async function main() {
  const kind = arg('tunnel', 'cloudflared');
  const manual = arg('url', null);

  if (!existsSync(resolve(ROOT, 'apps/api/dist/main.js'))
    || !existsSync(resolve(ROOT, 'packages/engine/dist/index.js'))) {
    console.error('Спочатку збери проєкт:  npm run build');
    process.exit(1);
  }
  if (!getEnv('TELEGRAM_BOT_TOKEN')) {
    console.error('У .env немає TELEGRAM_BOT_TOKEN — бот не підніметься.');
    process.exit(1);
  }

  let url = manual;
  if (!url) {
    url = kind === 'tailscale' ? await tailscale() : await cloudflared();
  }

  setEnv('WEBAPP_URL', url);
  console.log(`\nадреса мініапса: ${url}\n`);

  // API стартує ПІСЛЯ запису .env — інакше бот не побачить адреси
  run('node', ['apps/api/dist/main.js'], { stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 1500));
  run('npm', ['run', 'dev', '-w', '@minedrop/web'], { stdio: 'inherit' });

  const bar = '='.repeat(58);
  setTimeout(() => {
    console.log(`\n${bar}`);
    console.log(' МІНІАПС ГОТОВИЙ');
    console.log(bar);
    console.log(` адреса:   ${url}`);
    console.log(` адмінка:  ${url}/admin   (і http://localhost:3000/admin)`);
    console.log(' у телеграмі: відкрий свого бота і надішли /start');
    console.log(' або тисни кнопку «Грати» біля поля вводу');
    console.log('');
    console.log(' Ctrl+C — зупинити все разом');
    console.log(`${bar}\n`);
  }, 6000);
}

main().catch((e) => {
  console.error('\n' + e.message);
  shutdown(1);
});
