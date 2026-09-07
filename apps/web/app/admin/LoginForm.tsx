'use client';

/* Вхід у CRM. Логін і пароль заводяться в .env (ADMIN_LOGIN /
   ADMIN_PASSWORD) і засіваються сервером у колекцію `admins`.
   У відповідь приходить токен сесії — далі його додає lib.api(). */

import { useState } from 'react';
import s from './admin.module.css';
import { api, setToken, type AdminMe } from './lib';

export function LoginForm({ onDone, theme }: { onDone: (admin: AdminMe) => void; theme: 'dark' | 'light' }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!login.trim() || !password) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ token: string; admin: AdminMe }>('/login', {
        method: 'POST',
        body: JSON.stringify({ login: login.trim(), password }),
      });
      setToken(r.token);
      setPassword('');
      onDone(r.admin);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.loginWrap} data-theme={theme}>
      <form
        className={s.loginBox}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <h1>MINEDROP · CRM</h1>
        <p className={s.loginHint}>Вход только для администратора.</p>

        <label className={s.label} htmlFor="admin-login">Логин</label>
        <input
          id="admin-login"
          className={s.input}
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          autoComplete="username"
          autoFocus
        />

        <label className={s.label} htmlFor="admin-password">Пароль</label>
        <input
          id="admin-password"
          className={s.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />

        {err && <div className={s.err}>{err}</div>}

        <button
          type="submit"
          className={s.confirm}
          disabled={busy || !login.trim() || !password}
        >
          {busy ? 'Вхожу…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
