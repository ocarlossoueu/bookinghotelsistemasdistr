import { useEffect, useState } from 'react';
import { api, brl, fmtDate } from '../api';
import { useSession } from '../App';
import { Badge, Button, Card, statusLabel, statusTone, useToast } from '../components/ui';
import { useReplica } from '../hooks';
import type { Booking } from '../types';

interface AuditEntry {
  id: number;
  at: string;
  correlation_id: string;
  user_name: string | null;
  action: string;
  resource: string;
  result: string;
  detail: string | null;
  instance_id: string;
}

export default function Reception() {
  const { catalog } = useSession();
  const st = useReplica();
  const toast = useToast();
  const [view, setView] = useState<'bookings' | 'audit'>('bookings');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  const load = () => {
    api<{ bookings: Booking[] }>('GET', '/admin/bookings').then((r) => setBookings(r.bookings));
    api<{ entries: AuditEntry[] }>('GET', '/admin/audit').then((r) => setAudit(r.entries));
  };
  useEffect(load, [st.lastSeq]);

  const active = bookings.filter((b) => b.status === 'CONFIRMED');
  const revenue = active.reduce((s, b) => s + b.totalPrice, 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Card className="text-center">
          <div className="text-2xl font-bold">{active.length}</div>
          <div className="text-xs text-slate-500">confirmadas</div>
        </Card>
        <Card className="text-center">
          <div className="text-2xl font-bold">{bookings.filter((b) => b.status === 'HOLD').length}</div>
          <div className="text-xs text-slate-500">pré-reservas</div>
        </Card>
        <Card className="text-center">
          <div className="text-lg font-bold">{brl(revenue)}</div>
          <div className="text-xs text-slate-500">receita</div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl bg-white p-1">
        {(['bookings', 'audit'] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} className={`rounded-lg py-2 text-sm ${view === v ? 'bg-brand-700 text-white' : ''}`}>
            {v === 'bookings' ? 'Reservas' : 'Auditoria'}
          </button>
        ))}
      </div>

      {view === 'bookings' &&
        bookings.map((b) => (
          <Card key={b.id}>
            <div className="flex justify-between">
              <div>
                <div className="font-bold">
                  Apto {b.roomId} · {b.guestName}
                </div>
                <div className="text-sm text-slate-600">
                  {fmtDate(b.checkIn)} → {fmtDate(b.checkOut)} · {b.guests}p · {catalog.layouts[b.bedLayout]?.label}
                </div>
                <div className="font-mono text-[10px] text-slate-400">{b.id}</div>
              </div>
              <div className="text-right">
                <Badge tone={statusTone(b.status)}>{statusLabel(b.status)}</Badge>
                <div className="text-sm font-semibold">{brl(b.totalPrice)}</div>
              </div>
            </div>
            {(b.status === 'CONFIRMED' || b.status === 'HOLD') && (
              <Button
                tone="ghost"
                className="mt-2 w-full py-2 text-sm text-rose-600"
                onClick={() =>
                  api('POST', `/bookings/${b.id}/cancel`)
                    .then(() => toast('Cancelada pela recepção', 'ok'))
                    .catch((e) => toast(e.message, 'err'))
                }
              >
                Cancelar
              </Button>
            )}
          </Card>
        ))}

      {view === 'audit' && (
        <Card>
          {audit.map((a) => (
            <div key={a.id} className="border-b border-slate-100 py-1.5 text-xs">
              <div className="flex justify-between">
                <span>
                  <b>{a.action}</b> {a.resource}
                </span>
                <Badge tone={a.result === 'DENIED' ? 'red' : a.result === 'CONFLICT' ? 'amber' : a.result === 'ERROR' ? 'red' : 'green'}>{a.result}</Badge>
              </div>
              <div className="text-slate-500">
                {new Date(a.at).toLocaleTimeString('pt-BR')} · {a.user_name ?? 'anônimo'} · {a.instance_id} · corr {a.correlation_id.slice(0, 8)}
                {a.detail ? ` · ${a.detail}` : ''}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
