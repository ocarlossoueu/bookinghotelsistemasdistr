import { useState } from 'react';
import { api, ApiError } from '../api';
import { useSession } from '../App';
import { Badge, Button, Card, useToast } from '../components/ui';
import { useLamport, useReplica } from '../hooks';
import { replica } from '../replica';

export default function Network() {
  const st = useReplica();
  const L = useLamport();
  const toast = useToast();
  const { logout } = useSession();
  const [lookupId, setLookupId] = useState('');
  const [lookup, setLookup] = useState<string | null>(null);

  const doLookup = async () => {
    try {
      const r = await api<{ booking: { roomId: number; status: string; guestName?: string } }>('GET', `/bookings/${lookupId.trim()}`);
      setLookup(`✅ Permitido: apto ${r.booking.roomId}, ${r.booking.status}`);
    } catch (err) {
      const e = err as ApiError;
      setLookup(`⛔ ${e.status} ${e.code}: ${e.message}`);
    }
  };

  return (
    <div className="space-y-3">
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-bold">Conexão em tempo real</h2>
          <Badge tone={st.connected ? 'green' : 'red'}>{st.connected ? 'WebSocket conectado' : 'desconectado'}</Badge>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Metric label="Atendido pelo nó" value={st.instanceId ?? '—'} />
          <Metric label="Celulares online" value={String(st.presence?.total ?? '—')} />
          <Metric label="Relógio de Lamport (L)" value={String(L)} />
          <Metric label="Último seq aplicado" value={String(st.lastSeq)} />
          <Metric label="Offset do relógio" value={`${Math.round(st.clock.offset)} ms`} />
          <Metric label="RTT (ida e volta)" value={st.clock.rtt == null ? '—' : `${st.clock.rtt} ms`} />
        </div>
        {st.presence && (
          <div className="mt-2 flex flex-wrap gap-1">
            {st.presence.instances.map((i) => (
              <Badge key={i.id} tone={i.id === st.instanceId ? 'violet' : 'slate'}>
                {i.id}: {i.connected} 📱
              </Badge>
            ))}
            <Badge tone={st.presence.listening ? 'green' : 'amber'}>{st.presence.listening ? 'LISTEN/NOTIFY ativo' : 'modo polling'}</Badge>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-2 font-bold">Consistência da réplica local</h2>
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <Metric label="aplicados" value={String(st.stats.applied)} />
          <Metric label="lacunas" value={String(st.stats.gaps)} />
          <Metric label="ressincr." value={String(st.stats.resyncs)} />
          <Metric label="duplicados" value={String(st.stats.duplicates)} />
          <Metric label="obsoletos" value={String(st.stats.stale)} />
          <Metric label="recup. offline" value={String(st.stats.missedWhileOffline)} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button tone={st.manualOffline ? 'primary' : 'warn'} onClick={() => replica.setOffline(!st.manualOffline)}>
            {st.manualOffline ? '🔌 Reconectar' : '✂️ Simular queda'}
          </Button>
          <Button tone="ghost" onClick={() => replica.resync().then(() => toast('Snapshot recarregado do servidor', 'ok'))}>
            🔄 Ressincronizar
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Simule a queda, faça outra pessoa reservar e reconecte: o celular busca os eventos perdidos pelo número de sequência e converge
          para o mesmo estado.
        </p>
      </Card>

      <Card>
        <h2 className="mb-2 font-bold">Segurança</h2>
        <div className="flex gap-2">
          <input
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            placeholder="ID de uma reserva"
            className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
          <Button tone="ghost" onClick={doLookup}>
            Ler
          </Button>
        </div>
        {lookup && <div className="mt-2 text-sm">{lookup}</div>}
        <p className="mt-1 text-xs text-slate-500">Autorização por objeto: só o dono ou a recepção leem a reserva. Toda tentativa vai para a auditoria.</p>
        <Button
          tone="ghost"
          className="mt-3 w-full"
          onClick={async () => {
            await api('POST', '/session/expire');
            toast('Credencial expirada. A próxima requisição será recusada.', 'info');
            setTimeout(() => api('GET', '/me').catch(() => logout()), 600);
          }}
        >
          ⏰ Expirar minha credencial
        </Button>
      </Card>

      <Card>
        <h2 className="mb-2 font-bold">Log de eventos (ordenado por seq)</h2>
        <div className="space-y-1">
          {st.log.length === 0 && <div className="text-sm text-slate-500">Nenhum evento ainda. Faça uma reserva!</div>}
          {st.log.map((e) => (
            <div key={e.seq} className="flex items-start gap-2 border-b border-slate-100 py-1 text-xs">
              <span className="w-10 shrink-0 font-mono text-slate-400">#{e.seq}</span>
              <span className="flex-1">{e.summary}</span>
              <span className="shrink-0 text-right font-mono text-[10px] text-slate-400">
                L{e.lamport}
                <br />
                {e.instanceId}
                {e.source === 'catchup' && <span className="text-amber-600"> ↺</span>}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="truncate font-mono text-sm font-semibold">{value}</div>
    </div>
  );
}
