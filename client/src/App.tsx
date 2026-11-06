import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { ToastProvider } from './components/ui';
import { useReplica } from './hooks';
import Lab from './pages/Lab';
import Login from './pages/Login';
import Mine from './pages/Mine';
import Network from './pages/Network';
import Reception from './pages/Reception';
import Rooms from './pages/Rooms';
import { replica } from './replica';
import type { Catalog, User } from './types';

interface Session {
  user: User;
  catalog: Catalog;
  logout: () => void;
}
const SessionCtx = createContext<Session | null>(null);
export const useSession = () => useContext(SessionCtx)!;

type Tab = 'rooms' | 'mine' | 'lab' | 'net' | 'admin';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [booting, setBooting] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('rooms');

  const logout = () => {
    replica.stop();
    setToken(null);
    setUser(null);
  };

  useEffect(() => {
    setUnauthorizedHandler((code) => {
      setNotice(code === 'TOKEN_EXPIRED' ? 'Sua sessão expirou. Entre novamente.' : 'Sessão inválida. Entre novamente.');
      logout();
    });
    api<Catalog>('GET', '/catalog').then(setCatalog);
    if (getToken()) {
      api<{ user: User }>('GET', '/me')
        .then((r) => setUser(r.user))
        .catch(() => setToken(null))
        .finally(() => setBooting(false));
    } else setBooting(false);
  }, []);

  useEffect(() => {
    if (user) void replica.start();
  }, [user]);

  if (booting || !catalog) return <div className="grid h-full place-items-center text-slate-500">Carregando…</div>;

  return (
    <ToastProvider>
      {!user ? (
        <Login
          notice={notice}
          onLogin={(u) => {
            setNotice(null);
            setTab('rooms');
            setUser(u);
          }}
        />
      ) : (
        <SessionCtx.Provider value={{ user, catalog, logout }}>
          <Shell tab={tab} setTab={setTab} />
        </SessionCtx.Provider>
      )}
    </ToastProvider>
  );
}

function Shell({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const { user, logout } = useSession();
  const st = useReplica();
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'rooms', label: 'Quartos', icon: '🏨' },
    { id: 'mine', label: 'Minhas', icon: '🧾' },
    { id: 'lab', label: 'Corrida', icon: '⚡' },
    { id: 'net', label: 'Rede', icon: '📡' },
    ...(user.role === 'RECEPTION' ? [{ id: 'admin' as Tab, label: 'Recepção', icon: '🛎️' }] : []),
  ];
  return (
    <div className="mx-auto flex h-full max-w-lg flex-col">
      <header className="sticky top-0 z-30 flex items-center justify-between bg-brand-900 px-4 py-3 text-white">
        <div>
          <div className="text-base font-bold leading-tight">Hotel Distribuído</div>
          <div className="text-xs text-teal-200">
            {user.role === 'RECEPTION' ? '🛎️ Recepção' : '👤'} {user.name}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setTab('net')} className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs">
            <span className={`h-2.5 w-2.5 rounded-full ${st.connected ? 'bg-emerald-400' : 'animate-pulse bg-rose-400'}`} />
            {st.connected ? `${st.presence?.total ?? '…'} online` : 'offline'}
          </button>
          <button onClick={logout} className="text-xs text-teal-200 underline">
            sair
          </button>
        </div>
      </header>
      {!st.connected && st.ready && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900">
          Sem tempo real: dados podem estar desatualizados. {st.manualOffline ? '(desconexão simulada)' : 'Reconectando…'}
        </div>
      )}
      <main className="flex-1 overflow-y-auto px-3 pb-24 pt-3">
        {tab === 'rooms' && <Rooms />}
        {tab === 'mine' && <Mine />}
        {tab === 'lab' && <Lab />}
        {tab === 'net' && <Network />}
        {tab === 'admin' && <Reception />}
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-w-lg border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex flex-1 flex-col items-center py-2 text-xs ${tab === t.id ? 'font-semibold text-brand-700' : 'text-slate-500'}`}
          >
            <span className="text-xl">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
