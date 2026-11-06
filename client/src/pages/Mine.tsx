import { useCallback, useEffect, useState } from 'react';
import { api, brl, fmtDate } from '../api';
import { useSession } from '../App';
import { Badge, Button, Card, statusLabel, statusTone, useToast } from '../components/ui';
import { useNow, useReplica } from '../hooks';
import type { Booking } from '../types';

export default function Mine() {
  const { catalog, user } = useSession();
  const st = useReplica();
  const now = useNow(1000);
  const toast = useToast();
  const [list, setList] = useState<Booking[] | null>(null);

  const load = useCallback(() => api<{ bookings: Booking[] }>('GET', '/bookings/mine').then((r) => setList(r.bookings)), []);

  // Recarrega quando chega um evento que envolve uma reserva minha.
  const mineSignature = st.log.filter((e) => e.type.startsWith('booking.')).length;
  useEffect(() => {
    void load();
  }, [load, mineSignature]);

  const act = async (b: Booking, action: 'confirm' | 'cancel') => {
    try {
      const r = await api<{ booking: Booking }>('POST', `/bookings/${b.id}/${action}`);
      toast(action === 'confirm' ? `Confirmada: ${r.booking.receiptCode}` : 'Cancelada', 'ok');
      void load();
    } catch (err) {
      toast((err as Error).message, 'err');
      void load();
    }
  };

  if (!list) return <div className="p-6 text-center text-slate-500">Carregando…</div>;
  if (list.length === 0) return <div className="p-6 text-center text-slate-500">Você ainda não fez reservas, {user.name}.</div>;

  return (
    <div className="space-y-3">
      {list.map((b) => {
        const left = b.status === 'HOLD' && b.holdExpiresAt ? Math.max(0, Math.ceil((Date.parse(b.holdExpiresAt) - now) / 1000)) : 0;
        return (
          <Card key={b.id}>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-bold">Apto {b.roomId}</div>
                <div className="text-sm text-slate-600">
                  {fmtDate(b.checkIn)} → {fmtDate(b.checkOut)} · {b.guests} hóspede(s)
                </div>
                <div className="text-xs text-slate-500">{catalog.layouts[b.bedLayout]?.label}</div>
              </div>
              <div className="text-right">
                <Badge tone={statusTone(b.status)}>{statusLabel(b.status)}</Badge>
                <div className="mt-1 font-semibold">{brl(b.totalPrice)}</div>
              </div>
            </div>
            {b.receiptCode && (
              <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 font-mono text-sm text-emerald-800">Comprovante {b.receiptCode}</div>
            )}
            <div className="mt-2 text-[11px] text-slate-400">
              id {b.id.slice(0, 8)} · versão {b.version} · Lamport {b.lamport} · nó {b.instanceId}
            </div>
            {b.status === 'HOLD' && left > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Button onClick={() => act(b, 'confirm')}>Confirmar ({left}s)</Button>
                <Button tone="ghost" onClick={() => act(b, 'cancel')}>
                  Desistir
                </Button>
              </div>
            )}
            {b.status === 'CONFIRMED' && (
              <Button tone="ghost" className="mt-3 w-full text-rose-600" onClick={() => act(b, 'cancel')}>
                Cancelar reserva
              </Button>
            )}
          </Card>
        );
      })}
    </div>
  );
}
