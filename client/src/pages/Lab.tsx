import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { Badge, Button, Card, useToast } from '../components/ui';
import { useNow, useReplica } from '../hooks';

/**
 * Corrida sincronizada: todos os celulares disparam no MESMO instante (relógio
 * corrigido pelo offset de Cristian) para reservar o mesmo recurso.
 */
export default function Lab() {
  const { user } = useSession();
  const st = useReplica();
  const now = useNow(100);
  const toast = useToast();
  const [auto, setAuto] = useState(true);
  const [sent, setSent] = useState<number | null>(null);
  const firedFor = useRef<number | null>(null);
  const round = st.lab.round;
  const attempts = [...st.lab.attempts].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const fireAt = round ? Date.parse(round.fireAt) : 0;
  const msLeft = fireAt - now;
  const mine = attempts.find((a) => a.userId === user.id);
  const winners = attempts.filter((a) => a.success);

  const fire = async () => {
    if (!round || firedFor.current === round.id) return;
    firedFor.current = round.id;
    setSent(Date.now());
    try {
      await api('POST', `/lab/rounds/${round.id}/attempt`);
    } catch (err) {
      toast((err as Error).message, 'err');
      firedFor.current = null;
    }
  };

  // Disparo automático no instante combinado (horário do servidor estimado).
  useEffect(() => {
    if (!round || !auto || firedFor.current === round.id) return;
    const delay = fireAt - Date.now() - st.clock.offset;
    if (delay < -5000) return;
    const t = setTimeout(fire, Math.max(0, delay));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round?.id, auto, st.clock.offset]);

  useEffect(() => {
    setSent(null);
  }, [round?.id]);

  const start = (mode: 'SAFE' | 'NAIVE') => api('POST', '/lab/rounds', { mode }).catch((e) => toast(e.message, 'err'));

  return (
    <div className="space-y-3">
      <Card>
        <h2 className="font-bold">⚡ Corrida pelo último quarto</h2>
        <p className="mt-1 text-sm text-slate-600">
          Todos os celulares tentam reservar <b>o mesmo recurso no mesmo instante</b>. Com trava, só um vence. Sem trava, o servidor
          “verifica e depois grava” e ocorre <i>overbooking</i>.
        </p>
        {user.role === 'RECEPTION' ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button onClick={() => start('SAFE')}>🔒 Rodada com trava</Button>
            <Button tone="danger" onClick={() => start('NAIVE')}>
              🔓 Rodada sem trava
            </Button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-slate-500">A recepção inicia as rodadas. Deixe esta tela aberta.</p>
        )}
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Disparar automaticamente no instante combinado
        </label>
      </Card>

      {round && (
        <Card className={round.mode === 'SAFE' ? 'ring-2 ring-emerald-400' : 'ring-2 ring-rose-400'}>
          <div className="flex items-center justify-between">
            <span className="font-semibold">Rodada #{round.id}</span>
            <Badge tone={round.mode === 'SAFE' ? 'green' : 'red'}>{round.mode === 'SAFE' ? 'com exclusão mútua' : 'sem controle'}</Badge>
          </div>
          <div className="my-4 text-center">
            {msLeft > 0 ? (
              <div className="font-mono text-6xl font-bold tabular-nums">{(msLeft / 1000).toFixed(1)}</div>
            ) : (
              <div className="text-xl font-bold">{winners.length === 1 ? '🏆 1 vencedor' : winners.length > 1 ? `💥 ${winners.length} vencedores = OVERBOOKING` : '…'}</div>
            )}
            <div className="text-xs text-slate-500">
              relógio sincronizado com o servidor (offset {Math.round(st.clock.offset)} ms, RTT {st.clock.rtt ?? '—'} ms)
            </div>
          </div>
          <Button className="w-full py-5 text-xl" disabled={msLeft > 250 || Boolean(mine) || firedFor.current === round.id} onClick={fire}>
            {mine ? (mine.success ? '🏆 Você conseguiu!' : '😢 Alguém chegou antes') : sent ? 'Enviado…' : 'RESERVAR!'}
          </Button>
        </Card>
      )}

      {round && attempts.length > 0 && (
        <Card>
          <h3 className="mb-2 font-semibold">Chegada no servidor ({attempts.length})</h3>
          {attempts.map((a, i) => (
            <div key={a.id} className={`flex items-center justify-between border-b border-slate-100 py-1.5 text-sm ${a.userId === user.id ? 'font-semibold' : ''}`}>
              <span>
                {i + 1}. {a.userName}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-slate-400">
                  +{Date.parse(a.receivedAt) - fireAt}ms · L{a.lamport} · {a.instanceId}
                </span>
                {a.success ? <Badge tone="green">venceu</Badge> : <Badge>negado</Badge>}
              </span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
