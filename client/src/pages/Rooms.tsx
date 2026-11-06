import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, brl, fmtDate, nights, todayISO } from '../api';
import { useSession } from '../App';
import { Badge, Button, Card, Sheet, useToast } from '../components/ui';
import { useNow, useReplica } from '../hooks';
import { occupancy } from '../replica';
import type { Booking, Room } from '../types';

export default function Rooms() {
  const { catalog, user } = useSession();
  const st = useReplica();
  const now = useNow(1000);
  const [checkIn, setCheckIn] = useState(todayISO());
  const [checkOut, setCheckOut] = useState(todayISO(1));
  const [guests, setGuests] = useState(2);
  const [selected, setSelected] = useState<Room | null>(null);
  const n = nights(checkIn, checkOut);
  const validPeriod = n >= 1 && n <= 30;

  const floors = [3, 2, 1].map((f) => catalog.rooms.filter((r) => r.floor === f));

  const freeCount = useMemo(
    () => (validPeriod ? catalog.rooms.filter((r) => !occupancy(st.bookings, r.id, checkIn, checkOut, now)).length : 0),
    [st.bookings, checkIn, checkOut, now, validPeriod, catalog.rooms],
  );

  return (
    <div className="space-y-3">
      <Card>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-slate-500">
            Entrada
            <input
              type="date"
              value={checkIn}
              min={todayISO()}
              onChange={(e) => {
                setCheckIn(e.target.value);
                if (nights(e.target.value, checkOut) < 1) {
                  const d = new Date(e.target.value + 'T12:00:00');
                  d.setDate(d.getDate() + 1);
                  setCheckOut(d.toISOString().slice(0, 10));
                }
              }}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-slate-900"
            />
          </label>
          <label className="text-xs text-slate-500">
            Saída
            <input
              type="date"
              value={checkOut}
              min={checkIn}
              onChange={(e) => setCheckOut(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-slate-900"
            />
          </label>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-sm text-slate-600">Hóspedes</span>
          <div className="flex items-center gap-3">
            <button onClick={() => setGuests(Math.max(1, guests - 1))} className="h-9 w-9 rounded-full bg-slate-100 text-lg">
              −
            </button>
            <span className="w-6 text-center text-lg font-semibold">{guests}</span>
            <button onClick={() => setGuests(Math.min(4, guests + 1))} className="h-9 w-9 rounded-full bg-slate-100 text-lg">
              +
            </button>
          </div>
        </div>
        <div className="mt-2 text-xs text-slate-500">
          {validPeriod ? `${n} diária(s) · ${freeCount} de 12 apartamentos livres` : 'Período inválido (1 a 30 diárias)'}
        </div>
      </Card>

      <div className="flex flex-wrap gap-2 px-1 text-xs">
        <Badge tone="green">livre</Badge>
        <Badge tone="amber">pré-reservado</Badge>
        <Badge tone="red">reservado</Badge>
        <Badge tone="blue">seu</Badge>
      </div>

      <div className="overflow-hidden rounded-3xl border-4 border-slate-300 bg-slate-200">
        <div className="bg-slate-400 py-1 text-center text-[10px] font-bold uppercase tracking-widest text-white">Cobertura</div>
        {floors.map((rooms, idx) => {
          const floor = 3 - idx;
          return (
            <div key={floor} className="border-b-2 border-slate-300 p-2">
              <div className="mb-1 flex items-center justify-between px-1 text-xs text-slate-600">
                <span className="font-semibold">{floor}º andar</span>
                <span>
                  {brl(rooms[0].pricePerPerson)}/pessoa · {Math.round(catalog.floorMultiplier[floor] * 100)}%
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {rooms.map((r) => (
                  <RoomTile key={r.id} room={r} occ={validPeriod ? occupancy(st.bookings, r.id, checkIn, checkOut, now) : undefined} mineId={user.id} now={now} onClick={() => validPeriod && setSelected(r)} />
                ))}
              </div>
            </div>
          );
        })}
        <div className="bg-brand-900 py-2 text-center text-xs font-semibold text-teal-100">Térreo · 🛎️ Recepção</div>
      </div>

      <p className="px-1 text-center text-xs text-slate-500">
        O 3º andar tem configuração fixa (1 casal + 2 solteiros). Os demais são adaptáveis. Máx. 4 pessoas por apto.
      </p>

      <RoomSheet room={selected} onClose={() => setSelected(null)} checkIn={checkIn} checkOut={checkOut} guests={guests} />
    </div>
  );
}

function RoomTile({ room, occ, mineId, now, onClick }: { room: Room; occ?: Booking; mineId: string; now: number; onClick: () => void }) {
  let cls = 'bg-emerald-500 text-white';
  let label = 'livre';
  if (occ) {
    const mine = occ.userId === mineId;
    if (mine) {
      cls = 'bg-sky-500 text-white';
      label = occ.status === 'HOLD' ? `seu ${secondsLeft(occ, now)}s` : 'seu';
    } else if (occ.status === 'HOLD') {
      cls = 'bg-amber-400 text-amber-950';
      label = `${secondsLeft(occ, now)}s`;
    } else {
      cls = 'bg-rose-500 text-white';
      label = 'ocupado';
    }
  }
  return (
    <button onClick={onClick} className={`${cls} flex aspect-square flex-col items-center justify-center rounded-xl shadow-sm transition active:scale-95`}>
      <span className="text-lg font-bold">{room.id}</span>
      <span className="text-[10px] font-medium">{label}</span>
      <span className="text-[10px]">{room.kind === 'FIXO' ? '🛏️+🛏🛏' : '↔️'}</span>
    </button>
  );
}

const secondsLeft = (b: Booking, now: number) => Math.max(0, Math.ceil((Date.parse(b.holdExpiresAt ?? '') - now) / 1000));

function RoomSheet({ room, onClose, checkIn, checkOut, guests }: { room: Room | null; onClose: () => void; checkIn: string; checkOut: string; guests: number }) {
  const { catalog, user } = useSession();
  const toast = useToast();
  const st = useReplica();
  const now = useNow(500);
  const [layout, setLayout] = useState('');
  const [busy, setBusy] = useState(false);
  const [simulateLoss, setSimulateLoss] = useState(false);
  const [held, setHeld] = useState<Booking | null>(null);
  const [result, setResult] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(null);

  const options = room ? room.layouts.filter((l) => catalog.layouts[l].capacity >= guests) : [];
  useEffect(() => {
    setLayout(options[0] ?? '');
    setHeld(null);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id, guests]);

  if (!room) return null;
  const n = nights(checkIn, checkOut);
  const total = room.pricePerPerson * guests * n;
  const occ = occupancy(st.bookings, room.id, checkIn, checkOut, now);
  const liveHeld = held ? st.bookings.find((b) => b.id === held.id) ?? held : null;
  const takenByOther = occ && occ.userId !== user.id;

  const hold = async () => {
    setBusy(true);
    setResult(null);
    const key = crypto.randomUUID(); // chave de idempotência desta operação lógica
    const body = { roomId: room.id, checkIn, checkOut, guests, bedLayout: layout };
    try {
      let r = await api<{ booking: Booking; replayed: boolean }>('POST', '/holds', body, { 'idempotency-key': key });
      if (simulateLoss) {
        // Simula: o servidor gravou, mas a resposta "se perdeu". O cliente repete com a MESMA chave.
        const firstId = r.booking.id;
        toast('⏱️ Resposta perdida (simulada). Repetindo com a mesma chave…', 'info');
        await new Promise((res) => setTimeout(res, 900));
        r = await api('POST', '/holds', body, { 'idempotency-key': key });
        setResult({
          tone: 'info',
          text: `Repetição reconhecida pelo servidor (replayed=${r.replayed}). Mesma reserva: ${r.booking.id === firstId ? 'sim' : 'não'} — nenhuma duplicata criada.`,
        });
      }
      setHeld(r.booking);
      toast(`Apto ${room.id} segurado por ${catalog.holdSeconds}s. Confirme!`, 'ok');
    } catch (err) {
      const e = err as ApiError;
      setResult({ tone: 'err', text: e.code === 'ROOM_UNAVAILABLE' ? `⚔️ Conflito: ${e.message}. Outro celular chegou antes.` : e.message });
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!held) return;
    setBusy(true);
    try {
      const r = await api<{ booking: Booking }>('POST', `/bookings/${held.id}/confirm`);
      setHeld(r.booking);
      setResult({ tone: 'ok', text: `✅ Reserva confirmada! Comprovante ${r.booking.receiptCode}` });
      toast(`Confirmada: ${r.booking.receiptCode}`, 'ok');
    } catch (err) {
      setResult({ tone: 'err', text: (err as Error).message });
      setHeld(null);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!held) return;
    setBusy(true);
    try {
      await api('POST', `/bookings/${held.id}/cancel`);
      setHeld(null);
      setResult({ tone: 'info', text: 'Pré-reserva cancelada e apartamento liberado.' });
    } catch (err) {
      setResult({ tone: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const isConfirmed = liveHeld?.status === 'CONFIRMED' || held?.status === 'CONFIRMED';
  const holdLeft = liveHeld?.status === 'HOLD' ? secondsLeft(liveHeld, now) : 0;
  const expired = held?.status === 'HOLD' && holdLeft === 0;

  return (
    <Sheet open onClose={onClose}>
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">Apartamento {room.id}</h2>
          <p className="text-sm text-slate-500">
            {room.floor}º andar · {room.kind === 'FIXO' ? 'configuração fixa' : 'camas adaptáveis'}
          </p>
        </div>
        <button onClick={onClose} className="text-2xl text-slate-400">
          ×
        </button>
      </div>

      <div className="mt-3 rounded-xl bg-slate-50 p-3 text-sm">
        {fmtDate(checkIn)} → {fmtDate(checkOut)} · {n} diária(s) · {guests} hóspede(s)
      </div>

      {takenByOther && !held && (
        <div className="mt-3 rounded-xl bg-amber-100 p-3 text-sm text-amber-900">
          {occ!.status === 'HOLD' ? `Outro hóspede está segurando este apto (${secondsLeft(occ!, now)}s).` : 'Já reservado neste período.'} Atualizado em tempo real.
        </div>
      )}

      {!held && (
        <>
          <div className="mt-4 text-sm font-semibold">Camas</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {options.map((l) => (
              <button
                key={l}
                onClick={() => setLayout(l)}
                className={`rounded-xl border p-2 text-left text-sm ${layout === l ? 'border-brand-600 bg-brand-50 font-semibold' : 'border-slate-200'}`}
              >
                {catalog.layouts[l].label}
                <div className="text-xs text-slate-500">até {catalog.layouts[l].capacity} pessoa(s)</div>
              </button>
            ))}
          </div>
          {options.length === 0 && <p className="mt-2 text-sm text-rose-600">Nenhuma configuração comporta {guests} hóspedes.</p>}
        </>
      )}

      <div className="mt-4 rounded-xl border border-slate-200 p-3 text-sm">
        <div className="flex justify-between">
          <span>
            {brl(room.pricePerPerson)} × {guests} pessoa(s) × {n} diária(s)
          </span>
        </div>
        <div className="mt-1 text-xs text-slate-500">
          Base {brl(catalog.basePrice)} × {Math.round(catalog.floorMultiplier[room.floor] * 100)}% ({room.floor}º andar)
        </div>
        <div className="mt-2 flex justify-between text-lg font-bold">
          <span>Total</span>
          <span>{brl(held?.totalPrice ?? total)}</span>
        </div>
      </div>

      {result && (
        <div
          className={`mt-3 rounded-xl p-3 text-sm ${result.tone === 'ok' ? 'bg-emerald-100 text-emerald-900' : result.tone === 'err' ? 'bg-rose-100 text-rose-900' : 'bg-sky-100 text-sky-900'}`}
        >
          {result.text}
        </div>
      )}

      <div className="mt-4 space-y-2">
        {!held && (
          <>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={simulateLoss} onChange={(e) => setSimulateLoss(e.target.checked)} />
              Simular perda da resposta (testa a idempotência)
            </label>
            <Button className="w-full" disabled={busy || !layout || Boolean(takenByOther)} onClick={hold}>
              {busy ? 'Enviando…' : `Pré-reservar por ${catalog.holdSeconds / 60} min`}
            </Button>
          </>
        )}
        {held && !isConfirmed && !expired && (
          <>
            <div className="text-center text-sm text-amber-700">
              Apartamento segurado para você: <b>{holdLeft}s</b>
            </div>
            <Button className="w-full" disabled={busy} onClick={confirm}>
              Confirmar reserva
            </Button>
            <Button tone="ghost" className="w-full" disabled={busy} onClick={cancel}>
              Desistir
            </Button>
          </>
        )}
        {held && expired && !isConfirmed && (
          <div className="rounded-xl bg-slate-100 p-3 text-center text-sm">⌛ A pré-reserva expirou e o apartamento foi liberado.</div>
        )}
        {isConfirmed && (
          <Button tone="ghost" className="w-full" onClick={onClose}>
            Fechar
          </Button>
        )}
      </div>
    </Sheet>
  );
}
