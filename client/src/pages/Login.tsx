import { useState } from 'react';
import { api, setToken } from '../api';
import { Button } from '../components/ui';
import type { User } from '../types';

export default function Login({ onLogin, notice }: { onLogin: (u: User) => void; notice: string | null }) {
  const [name, setName] = useState(localStorage.getItem('lastName') ?? '');
  const [role, setRole] = useState<'GUEST' | 'RECEPTION'>('GUEST');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: User }>('POST', '/session', { name: name.trim(), role, pin: role === 'RECEPTION' ? pin : undefined });
      setToken(r.token);
      localStorage.setItem('lastName', name.trim());
      onLogin(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-gradient-to-b from-brand-900 to-brand-700 px-6 py-10">
      <div className="mb-8 text-center text-white">
        <div className="text-5xl">🏨</div>
        <h1 className="mt-2 text-2xl font-bold">Hotel Distribuído</h1>
        <p className="mt-1 text-sm text-teal-100">12 apartamentos · reservas em tempo real</p>
      </div>
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-3xl bg-white p-6 shadow-xl">
        {notice && <div className="rounded-xl bg-amber-100 p-3 text-sm text-amber-900">{notice}</div>}
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
          {(['GUEST', 'RECEPTION'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              className={`rounded-lg py-2 text-sm font-medium ${role === r ? 'bg-white shadow' : 'text-slate-500'}`}
            >
              {r === 'GUEST' ? '👤 Hóspede' : '🛎️ Recepção'}
            </button>
          ))}
        </div>
        <label className="block">
          <span className="text-sm text-slate-600">Seu nome</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            minLength={2}
            maxLength={40}
            required
            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-brand-600"
            placeholder="Ex.: Ana"
          />
        </label>
        {role === 'RECEPTION' && (
          <label className="block">
            <span className="text-sm text-slate-600">PIN da recepção</span>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              inputMode="numeric"
              type="password"
              required
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3 outline-none focus:border-brand-600"
            />
          </label>
        )}
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <Button type="submit" disabled={busy || name.trim().length < 2} className="w-full">
          {busy ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>
    </div>
  );
}
