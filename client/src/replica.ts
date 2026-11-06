import { io, type Socket } from 'socket.io-client';
import { api, getToken } from './api';
import { lamport } from './lamport';
import type { Booking, HotelEvent, LabAttempt, LabRound } from './types';

/**
 * Réplica local do estado do hotel em cada celular.
 *  - Snapshot inicial consistente (seq + reservas ativas) via REST.
 *  - Atualizações em tempo real via WebSocket, aplicadas em ordem de `seq`.
 *  - Lacuna de seq (mensagem perdida/reconexão) => busca os eventos que faltam.
 *  - Versão por reserva => descarta atualizações antigas (consistência eventual convergente).
 *  - O servidor (PostgreSQL) é a autoridade: escritas sempre passam por ele.
 */

export interface LogEntry {
  seq: number;
  type: string;
  lamport: number;
  instanceId: string;
  at: number;
  summary: string;
  source: 'push' | 'catchup';
}

export interface Presence {
  instances: { id: string; connected: number }[];
  total: number;
  listening: boolean;
}

export interface ReplicaState {
  ready: boolean;
  connected: boolean;
  manualOffline: boolean;
  instanceId: string | null;
  lastSeq: number;
  bookings: Booking[];
  log: LogEntry[];
  stats: { applied: number; duplicates: number; stale: number; gaps: number; resyncs: number; missedWhileOffline: number };
  presence: Presence | null;
  clock: { offset: number; rtt: number | null };
  lab: { round: LabRound | null; attempts: LabAttempt[] };
  tick: number;
}

const ACTIVE = new Set(['HOLD', 'CONFIRMED']);

function summarize(e: HotelEvent): string {
  const b = e.payload?.booking;
  switch (e.type) {
    case 'booking.held':
      return `Apto ${b.roomId} pré-reservado (${b.checkIn} → ${b.checkOut})`;
    case 'booking.confirmed':
      return `Apto ${b.roomId} reserva confirmada`;
    case 'booking.cancelled':
      return `Apto ${b.roomId} reserva cancelada`;
    case 'booking.expired':
      return `Apto ${b.roomId} pré-reserva expirou`;
    case 'lab.round_started':
      return `Corrida #${e.payload.round.id} iniciada (${e.payload.round.mode === 'SAFE' ? 'com trava' : 'sem trava'})`;
    case 'lab.attempt':
      return `Corrida: ${e.payload.attempt.userName} ${e.payload.attempt.success ? 'VENCEU' : 'perdeu'}`;
    default:
      return e.type;
  }
}

class Replica {
  private map = new Map<string, Booking>();
  private buffer: HotelEvent[] = [];
  private socket: Socket | null = null;
  private listeners = new Set<() => void>();
  private catchingUp = false;
  private state: ReplicaState = {
    ready: false,
    connected: false,
    manualOffline: false,
    instanceId: null,
    lastSeq: 0,
    bookings: [],
    log: [],
    stats: { applied: 0, duplicates: 0, stale: 0, gaps: 0, resyncs: 0, missedWhileOffline: 0 },
    presence: null,
    clock: { offset: 0, rtt: null },
    lab: { round: null, attempts: [] },
    tick: 0,
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;

  private emit(patch: Partial<ReplicaState> = {}) {
    this.state = { ...this.state, ...patch, bookings: [...this.map.values()], tick: this.state.tick + 1 };
    this.listeners.forEach((l) => l());
  }

  /** Horário estimado do servidor (Date.now() corrigido pelo offset de Cristian). */
  serverNow = () => Date.now() + this.state.clock.offset;

  async start() {
    if (this.socket) return;
    const socket = io({ auth: { token: getToken() }, transports: ['websocket', 'polling'] });
    this.socket = socket;

    socket.on('connect', () => {
      this.emit({ connected: true });
      void this.syncClock();
      // Reconexão: busca tudo que aconteceu enquanto estava desconectado.
      if (this.state.ready) void this.catchUp(true);
    });
    socket.on('disconnect', () => this.emit({ connected: false }));
    socket.on('hello', (h: { instanceId: string }) => this.emit({ instanceId: h.instanceId }));
    socket.on('presence', (p: Presence) => this.emit({ presence: p }));
    socket.on('event', (e: HotelEvent) => this.onEvent(e, 'push'));
    socket.on('connect_error', (err) => console.warn('socket:', err.message));

    await this.resync();
    const lab = await api<{ round: LabRound; attempts: LabAttempt[] } | null>('GET', '/lab/current').catch(() => null);
    if (lab && 'round' in lab && lab.round) this.emit({ lab: { round: lab.round, attempts: lab.attempts } });
  }

  stop() {
    this.socket?.disconnect();
    this.socket = null;
    this.map.clear();
    this.state = { ...this.state, ready: false, connected: false, lastSeq: 0, log: [] };
  }

  /** Snapshot completo (estado + posição no log) vindo da autoridade. */
  async resync() {
    const s = await api<{ seq: number; bookings: Booking[]; instanceId: string }>('GET', '/state');
    this.map.clear();
    s.bookings.forEach((b) => this.map.set(b.id, b));
    this.buffer = this.buffer.filter((e) => e.seq > s.seq);
    this.emit({ ready: true, lastSeq: s.seq, stats: { ...this.state.stats, resyncs: this.state.stats.resyncs + 1 } });
    this.flushBuffer(true);
  }

  private onEvent(e: HotelEvent, source: LogEntry['source']) {
    if (!this.state.ready || this.catchingUp) {
      this.buffer.push(e);
      return;
    }
    if (e.seq <= this.state.lastSeq) {
      this.emit({ stats: { ...this.state.stats, duplicates: this.state.stats.duplicates + 1 } });
      return;
    }
    if (e.seq > this.state.lastSeq + 1) {
      // Lacuna detectada: guarda o evento e busca os que faltam no log do servidor.
      this.buffer.push(e);
      this.emit({ stats: { ...this.state.stats, gaps: this.state.stats.gaps + 1 } });
      void this.catchUp(false);
      return;
    }
    this.apply(e, source);
  }

  private apply(e: HotelEvent, source: LogEntry['source']) {
    lamport.receive(e.lamport);
    const stats = { ...this.state.stats, applied: this.state.stats.applied + 1 };
    let lab = this.state.lab;
    const b: Booking | undefined = e.payload?.booking;
    if (b) {
      const local = this.map.get(b.id);
      if (local && local.version >= b.version) {
        stats.stale += 1; // versão antiga: ignora
      } else if (ACTIVE.has(b.status)) {
        this.map.set(b.id, b);
      } else {
        this.map.delete(b.id);
      }
    }
    if (e.type === 'lab.round_started') lab = { round: e.payload.round, attempts: [] };
    if (e.type === 'lab.attempt' && lab.round?.id === e.payload.attempt.roundId) {
      if (!lab.attempts.some((a) => a.id === e.payload.attempt.id)) lab = { ...lab, attempts: [...lab.attempts, e.payload.attempt] };
    }
    const entry: LogEntry = { seq: e.seq, type: e.type, lamport: e.lamport, instanceId: e.instanceId, at: Date.now(), summary: summarize(e), source };
    this.emit({ lastSeq: e.seq, stats, lab, log: [entry, ...this.state.log].slice(0, 150) });
  }

  private flushBuffer(allowHoles: boolean) {
    this.buffer.sort((a, b) => a.seq - b.seq);
    const pending = this.buffer;
    this.buffer = [];
    for (const e of pending) {
      if (e.seq <= this.state.lastSeq) continue;
      // Após consultar o log, lacunas restantes são números não usados (transações desfeitas).
      if (e.seq === this.state.lastSeq + 1 || allowHoles) this.apply(e, 'push');
      else this.buffer.push(e);
    }
  }

  /** Busca no servidor os eventos posteriores ao último aplicado. */
  async catchUp(afterReconnect: boolean) {
    if (this.catchingUp) return;
    this.catchingUp = true;
    try {
      let missed = 0;
      for (;;) {
        const { events } = await api<{ events: HotelEvent[] }>('GET', `/events?after=${this.state.lastSeq}`);
        for (const e of events) if (e.seq > this.state.lastSeq) { this.apply(e, 'catchup'); missed++; }
        if (events.length < 500) break;
      }
      if (afterReconnect && missed) {
        this.emit({ stats: { ...this.state.stats, missedWhileOffline: this.state.stats.missedWhileOffline + missed } });
      }
    } catch {
      await this.resync().catch(() => undefined);
    } finally {
      this.catchingUp = false;
      this.flushBuffer(true);
    }
  }

  /** Sincronização de relógio (algoritmo de Cristian): offset = T_servidor + RTT/2 − T_local. */
  async syncClock() {
    const s = this.socket;
    if (!s) return;
    let best: { offset: number; rtt: number } | null = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const r = await s.timeout(3000).emitWithAck('time:ping', t0).catch(() => null);
      if (!r) continue;
      const t1 = Date.now();
      const rtt = t1 - t0;
      const offset = r.serverTime + rtt / 2 - t1;
      if (!best || rtt < best.rtt) best = { offset, rtt };
    }
    if (best) this.emit({ clock: best });
  }

  /** Simula queda de rede do celular (para demonstrar a ressincronização). */
  setOffline(off: boolean) {
    if (off) this.socket?.disconnect();
    else this.socket?.connect();
    this.emit({ manualOffline: off });
  }
}

export const replica = new Replica();

/** Reserva ativa (do ponto de vista da réplica) que ocupa o apto no período. */
export function occupancy(bookings: Booking[], roomId: number, checkIn: string, checkOut: string, now: number) {
  return bookings.find(
    (b) =>
      b.roomId === roomId &&
      (b.status === 'CONFIRMED' || (b.status === 'HOLD' && b.holdExpiresAt && Date.parse(b.holdExpiresAt) > now)) &&
      b.checkIn < checkOut &&
      checkIn < b.checkOut,
  );
}
