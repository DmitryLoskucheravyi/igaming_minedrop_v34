'use client';

/* ============================================================
   CRM /admin — вкладки: Игроки, Заявки (депозиты), Адреса.

   Доступ під адмін-логіном (колекція `admins` на сервері). Токен
   сесії лежить у localStorage, кожен запит іде з ним; 401 звідусіль
   повертає на форму входу.

   Було: єдиною перепоною стояло «не продакшн» на сервері — тобто в
   деві CRM була відкрита будь-кому, хто знає адресу. А `npm run tg`
   сам друкує {публічний тунель}/admin у консоль.
   ============================================================ */

import { useCallback, useEffect, useState } from 'react';
import s from './admin.module.css';
import { api, getToken, setToken, UNAUTHORIZED_EVENT, type AdminMe } from './lib';
import { LoginForm } from './LoginForm';
import { PlayersTab } from './PlayersTab';
import { RequestsTab } from './RequestsTab';
import { AddressesTab } from './AddressesTab';

type Tab = 'players' | 'requests' | 'addresses';
type Auth = 'checking' | 'in' | 'out';

export default function AdminPage() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const [tab, setTab] = useState<Tab>('players');
  const [pending, setPending] = useState(0);

  /* Токен є — питаємо сервер, чи сесія ще жива. Сесії живуть у пам'яті
     процесу API, тому після його рестарту токен у localStorage валідним
     уже не буде, і це нормально. */
  useEffect(() => {
    if (!getToken()) { setAuth('out'); return; }
    let alive = true;
    api<{ admin: AdminMe }>('/me')
      .then((r) => { if (alive) { setAdmin(r.admin); setAuth('in'); } })
      .catch(() => { if (alive) setAuth('out'); });
    return () => { alive = false; };
  }, []);

  // будь-який запит, що впав у 401 — сесія вмерла, показуємо вхід
  useEffect(() => {
    const onUnauthorized = () => { setAuth('out'); setAdmin(null); };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  // лічильник pending-заявок для бейджа — тягнемо незалежно від вкладки
  const pollPending = useCallback(async () => {
    try {
      const b = await api<{ pending: number }>('/payments');
      setPending(b.pending);
    } catch { /* мовчки: 401 обробить слухач вище */ }
  }, []);

  useEffect(() => {
    if (auth !== 'in') return;
    void pollPending();
    const t = setInterval(() => void pollPending(), 20_000);
    return () => clearInterval(t);
  }, [auth, pollPending]);

  const logout = useCallback(async () => {
    try { await api('/logout', { method: 'POST' }); } catch { /* усе одно виходимо */ }
    setToken(null);
    setAdmin(null);
    setAuth('out');
  }, []);

  if (auth === 'checking') {
    return <div className={s.shell}><div className={s.empty}>Проверяю сессию…</div></div>;
  }
  if (auth === 'out') {
    return <LoginForm onDone={(a) => { setAdmin(a); setAuth('in'); }} />;
  }

  const btn = (id: Tab) => `${s.tab} ${tab === id ? s.on : ''}`;

  return (
    <div className={s.shell}>
      <div className={s.tabs}>
        <button type="button" className={btn('players')} onClick={() => setTab('players')}>
          Игроки
        </button>
        <button type="button" className={btn('requests')} onClick={() => setTab('requests')}>
          Заявки{pending > 0 && <span className={s.dot}>{pending}</span>}
        </button>
        <button type="button" className={btn('addresses')} onClick={() => setTab('addresses')}>
          Адреса
        </button>

        <div className={s.who}>
          <span className={s.dim}>{admin?.login}</span>
          <button type="button" className={s.btnSm} onClick={() => void logout()}>Выйти</button>
        </div>
      </div>

      {tab === 'players' && <PlayersTab />}
      {tab === 'requests' && <RequestsTab onPending={setPending} />}
      {tab === 'addresses' && <AddressesTab />}
    </div>
  );
}
