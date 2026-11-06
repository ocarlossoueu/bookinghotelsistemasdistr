import pg from 'pg';
import { config } from './config.js';
import { ROOMS } from './domain.js';

// DATE como string 'YYYY-MM-DD', BIGINT e NUMERIC como number.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = pg.PoolClient;

/** Executa `fn` dentro de uma transação; faz ROLLBACK em caso de erro. */
export async function tx<T>(fn: (c: Db) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

const MIGRATION = `
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS rooms (
  id INT PRIMARY KEY,
  floor INT NOT NULL,
  kind TEXT NOT NULL,
  price_per_person NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('GUEST','RECEPTION')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id INT NOT NULL REFERENCES rooms(id),
  user_id UUID NOT NULL REFERENCES users(id),
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  guests INT NOT NULL CHECK (guests BETWEEN 1 AND 4),
  bed_layout TEXT NOT NULL,
  total_price NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('HOLD','CONFIRMED','CANCELLED','EXPIRED')),
  hold_expires_at TIMESTAMPTZ,
  receipt_code TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  lamport BIGINT NOT NULL,
  instance_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (check_out > check_in),
  -- Rede de segurança no banco: dois períodos ativos do mesmo apartamento nunca se sobrepõem.
  CONSTRAINT no_overlap EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in, check_out, '[)') WITH &&
  ) WHERE (status IN ('HOLD','CONFIRMED'))
);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings(user_id);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings(status, hold_expires_at);

-- Relógio lógico de Lamport global (compartilhado por todas as instâncias).
CREATE TABLE IF NOT EXISTS lamport_clock (
  id INT PRIMARY KEY CHECK (id = 1),
  value BIGINT NOT NULL
);
INSERT INTO lamport_clock (id, value) VALUES (1, 0) ON CONFLICT DO NOTHING;

-- Log de eventos ordenado (seq) que alimenta as réplicas dos celulares.
CREATE TABLE IF NOT EXISTS events (
  seq BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  lamport BIGINT NOT NULL,
  instance_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION notify_hotel_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('hotel_events', NEW.seq::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hotel_events_notify ON events;
CREATE TRIGGER hotel_events_notify AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_hotel_event();

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id TEXT NOT NULL,
  user_id UUID,
  user_name TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT,
  instance_id TEXT NOT NULL
);

-- Heartbeat das instâncias do servidor.
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  connected INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Laboratório de corrida: comparação entre modo com trava e modo ingênuo.
CREATE TABLE IF NOT EXISTS lab_rounds (
  id SERIAL PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('SAFE','NAIVE')),
  fire_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lab_attempts (
  id BIGSERIAL PRIMARY KEY,
  round_id INT NOT NULL REFERENCES lab_rounds(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  user_id UUID NOT NULL,
  user_name TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  lamport BIGINT NOT NULL,
  instance_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (round_id, user_id)
);
-- No modo seguro o banco também garante um único vencedor por rodada.
CREATE UNIQUE INDEX IF NOT EXISTS lab_one_winner ON lab_attempts(round_id) WHERE success AND mode = 'SAFE';
`;

export async function migrate(): Promise<void> {
  const c = await pool.connect();
  try {
    // Evita que duas instâncias migrem ao mesmo tempo.
    await c.query('SELECT pg_advisory_lock(424242)');
    await c.query(MIGRATION);
    for (const r of ROOMS) {
      await c.query(
        `INSERT INTO rooms (id, floor, kind, price_per_person) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET floor = EXCLUDED.floor, kind = EXCLUDED.kind, price_per_person = EXCLUDED.price_per_person`,
        [r.id, r.floor, r.kind, r.pricePerPerson],
      );
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(424242)').catch(() => undefined);
    c.release();
  }
}
