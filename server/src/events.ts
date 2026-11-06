import { EventEmitter } from 'node:events';
import pg from 'pg';
import { config } from './config.js';
import { pool, type Db } from './db.js';

export interface HotelEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  lamport: number;
  instanceId: string;
  createdAt: string;
}

function rowToEvent(r: any): HotelEvent {
  return {
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    lamport: r.lamport,
    instanceId: r.instance_id,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * Avança o relógio de Lamport global: L = max(L, L_cliente) + 1.
 * A linha fica bloqueada até o fim da transação, o que também serializa a
 * gravação de eventos: a ordem de `seq` coincide com a ordem de commit.
 */
export async function tickLamport(c: Db, clientLamport = 0): Promise<number> {
  const { rows } = await c.query(
    'UPDATE lamport_clock SET value = GREATEST(value, $1::bigint) + 1 WHERE id = 1 RETURNING value',
    [Math.max(0, Math.floor(clientLamport))],
  );
  return rows[0].value;
}

/** Grava um evento na MESMA transação da mudança de estado (padrão outbox transacional). */
export async function appendEvent(
  c: Db,
  type: string,
  payload: Record<string, unknown>,
  lamport?: number,
): Promise<HotelEvent> {
  const l = lamport ?? (await tickLamport(c));
  const { rows } = await c.query(
    'INSERT INTO events (type, payload, lamport, instance_id) VALUES ($1, $2, $3, $4) RETURNING *',
    [type, JSON.stringify(payload), l, config.instanceId],
  );
  return rowToEvent(rows[0]);
}

export async function eventsAfter(seq: number, limit = 500): Promise<HotelEvent[]> {
  const { rows } = await pool.query('SELECT * FROM events WHERE seq > $1 ORDER BY seq LIMIT $2', [seq, limit]);
  return rows.map(rowToEvent);
}

export async function lastSeq(c: Db | pg.Pool = pool): Promise<number> {
  const { rows } = await c.query('SELECT COALESCE(MAX(seq), 0) AS seq FROM events');
  return rows[0].seq;
}

/**
 * Barramento entre instâncias: cada nó escuta o canal `hotel_events` (LISTEN/NOTIFY)
 * e repassa os eventos, em ordem de `seq`, aos celulares conectados nele.
 * Se o LISTEN não estiver disponível (ex.: conexão via pooler), usa polling.
 */
export class EventBus extends EventEmitter {
  private cursor = 0;
  private listener?: pg.Client;
  private pollTimer?: NodeJS.Timeout;
  private draining = false;
  private pending = false;
  private stopped = false;

  async start(): Promise<void> {
    this.cursor = await lastSeq();
    await this.connectListener();
    // Polling de segurança: cobre notificações perdidas durante reconexões.
    this.pollTimer = setInterval(() => void this.drain(), 2000);
  }

  private async connectListener(): Promise<void> {
    if (this.stopped) return;
    try {
      const client = new pg.Client({ connectionString: config.databaseUrl });
      client.on('notification', () => void this.drain());
      client.on('error', (err) => {
        console.warn('[bus] erro no LISTEN, reconectando:', err.message);
        this.listener = undefined;
        client.end().catch(() => undefined);
        setTimeout(() => void this.connectListener(), 1000);
      });
      await client.connect();
      await client.query('LISTEN hotel_events');
      this.listener = client;
      void this.drain();
    } catch (err) {
      console.warn('[bus] LISTEN indisponível, usando apenas polling:', (err as Error).message);
      setTimeout(() => void this.connectListener(), 5000);
    }
  }

  /** Busca eventos novos a partir do cursor e emite em ordem. */
  async drain(): Promise<void> {
    if (this.draining) {
      this.pending = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.pending = false;
        const events = await eventsAfter(this.cursor);
        for (const e of events) {
          this.cursor = e.seq;
          this.emit('event', e);
        }
        if (events.length === 500) this.pending = true;
      } while (this.pending && !this.stopped);
    } catch (err) {
      console.warn('[bus] falha ao buscar eventos:', (err as Error).message);
    } finally {
      this.draining = false;
    }
  }

  get listening(): boolean {
    return Boolean(this.listener);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.listener?.end().catch(() => undefined);
  }
}
