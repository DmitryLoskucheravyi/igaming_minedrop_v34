'use client';

/* ============================================================
   CRM /admin — вкладки: Игроки, Заявки (депозиты), Адреса.
   Без авторизації; API-роути /api/admin/* працюють тільки поза
   продакшном. Піднімається разом із рештою (маршрут Next).
   ============================================================ */

import { useCallback, useEffect, useState } from 'react';
import s from './admin.module.css';
import { api } from './lib';
import { PlayersTab } from './PlayersTab';
import { RequestsTab } from './RequestsTab';
import { AddressesTab } from './AddressesTab';

type Tab = 'players' | 'requests' | 'addresses';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('players');
  const [pending, setPending] = useState(0);

  // лічильник pending-заявок для бейджа — тягнемо незалежно від вкладки
  const pollPending = useCallback(async () => {
    try {
      const b = await api<{ pending: number }>('/payments');
      setPending(b.pending);
    } catch { /* мовчки */ }
  }, []);
  useEffect(() => {
    void pollPending();
    const t = setInterval(() => void pollPending(), 20_000);
    return () => clearInterval(t);
  }, [pollPending]);

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
      </div>

      {tab === 'players' && <PlayersTab />}
      {tab === 'requests' && <RequestsTab onPending={setPending} />}
      {tab === 'addresses' && <AddressesTab />}
    </div>
  );
}
