import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { User } from './auth.js';
import { config } from './config.js';
import { pool, tx, type Db } from './db.js';
import { getRoom, LAYOUTS, MAX_GUESTS, MAX_NIGHTS, nightsBetween, quote, validateLayout, type LayoutCode } from './domain.js';
import { AppError, PG, pgCode } from './errors.js';
import { appendEvent, lastSeq, tickLamport } from './events.js';

export const holdInput = z.object({
  roomId: z.number().int(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guests: z.number().int().min(1).max(MAX_GUESTS),
  bedLayout: z.enum(Object.keys(LAYOUTS) as [LayoutCode, ...LayoutCode[]]),
});
export type HoldInput = z.infer<typeof holdInput>;

/** Projeção pública de uma reserva (sem nome do hóspede): é o que vai para as réplicas. */
export interface PublicBooking {
  id: string;
  roomId: number;
  userId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  bedLayout: string;
  totalPrice: number;
  status: 'HOLD' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
  holdExpiresAt: string | null;
  version: number;
  lamport: number;
  instanceId: string;
  updatedAt: string;
}

export interface PrivateBooking extends PublicBooking {
  receiptCode: string | null;
  guestName?: string;
  createdAt: string;
}

function toPublic(r: any): PublicBooking {
  return {
    id: r.id,
    roomId: r.room_id,
    userId: r.user_id,
    checkIn: r.check_in,
    checkOut: r.check_out,
    guests: r.guests,
    bedLayout: r.bed_layout,
    totalPrice: r.total_price,
    status: r.status,
    holdExpiresAt: r.hold_expires_at ? new Date(r.hold_expires_at).toISOString() : null,
    version: r.version,
    lamport: r.lamport,
    instanceId: r.instance_id,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function toPrivate(r: any): PrivateBooking {
  return {
    ...toPublic(r),
    receiptCode: r.receipt_code,
    guestName: r.guest_name,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export function todayLocal(): string {
  // 'en-CA' formata como YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone }).format(new Date());
}

const requestHash = (userId: string, i: HoldInput) =>
  createHash('sha256')
    .update(JSON.stringify([userId, i.roomId, i.checkIn, i.checkOut, i.guests, i.bedLayout]))
    .digest('hex');

/** Trava exclusiva (exclusão mútua) por apartamento, liberada no fim da transação. */
async function lockRoom(c: Db, roomId: number) {
  await c.query('SELECT pg_advisory_xact_lock(1, $1)', [roomId]);
}

/** Expira pré-reservas vencidas. SKIP LOCKED evita que duas instâncias disputem a mesma linha. */
async function expireHolds(c: Db, roomId?: number) {
  const { rows } = await c.query(
    `UPDATE bookings SET status = 'EXPIRED', version = version + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM bookings
       WHERE status = 'HOLD' AND hold_expires_at < now() AND ($1::int IS NULL OR room_id = $1)
       FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [roomId ?? null],
  );
  for (const r of rows) await appendEvent(c, 'booking.expired', { booking: toPublic(r) });
  return rows.length;
}

export async function sweepExpiredHolds(): Promise<number> {
  return tx((c) => expireHolds(c));
}

export interface HoldResult {
  booking: PrivateBooking;
  replayed: boolean;
  lamport: number;
}

/**
 * Cria uma pré-reserva (HOLD) com validade limitada.
 * Camadas de proteção contra condição de corrida:
 *  1. trava consultiva por apartamento (pg_advisory_xact_lock) — exclusão mútua;
 *  2. verificação de sobreposição dentro da seção crítica;
 *  3. constraint EXCLUDE no banco — impede sobreposição mesmo se o código falhar;
 *  4. chave de idempotência gravada atomicamente com a reserva — repetição segura.
 */
export async function createHold(user: User, input: HoldInput, idempotencyKey: string, clientLamport: number): Promise<HoldResult> {
  const room = getRoom(input.roomId);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Apartamento inexistente');
  const layoutErr = validateLayout(room, input.bedLayout, input.guests);
  if (layoutErr) throw new AppError(422, 'INVALID_LAYOUT', layoutErr);
  const nights = nightsBetween(input.checkIn, input.checkOut);
  if (!(nights >= 1)) throw new AppError(422, 'INVALID_DATES', 'A saída deve ser depois da entrada');
  if (nights > MAX_NIGHTS) throw new AppError(422, 'INVALID_DATES', `Máximo de ${MAX_NIGHTS} diárias`);
  if (input.checkIn < todayLocal()) throw new AppError(422, 'INVALID_DATES', 'A entrada não pode ser no passado');

  const hash = requestHash(user.id, input);
  const price = quote(room, input.guests, input.checkIn, input.checkOut);

  try {
    return await tx(async (c) => {
      await lockRoom(c, room.id);

      // A chave é consultada ANTES de checar disponibilidade: uma repetição devolve o resultado original.
      const prev = await c.query('SELECT * FROM bookings WHERE idempotency_key = $1', [idempotencyKey]);
      if (prev.rows[0]) {
        const p = prev.rows[0];
        if (p.user_id !== user.id || p.request_hash !== hash) {
          throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Chave de idempotência já usada com outro conteúdo');
        }
        const lamport = await tickLamport(c, clientLamport);
        return { booking: toPrivate(p), replayed: true, lamport };
      }

      await expireHolds(c, room.id);

      const conflict = await c.query(
        `SELECT id, status, check_in, check_out, user_id FROM bookings
         WHERE room_id = $1 AND status IN ('HOLD','CONFIRMED')
           AND daterange(check_in, check_out, '[)') && daterange($2::date, $3::date, '[)')
         LIMIT 1`,
        [room.id, input.checkIn, input.checkOut],
      );
      if (conflict.rows[0]) {
        const cf = conflict.rows[0];
        throw new AppError(409, 'ROOM_UNAVAILABLE', `Apartamento ${room.id} já está ${cf.status === 'HOLD' ? 'pré-reservado' : 'reservado'} no período`, {
          status: cf.status,
          checkIn: cf.check_in,
          checkOut: cf.check_out,
          mine: cf.user_id === user.id,
        });
      }

      const activeHolds = await c.query("SELECT count(*)::int AS n FROM bookings WHERE user_id = $1 AND status = 'HOLD'", [user.id]);
      if (activeHolds.rows[0].n >= 2) {
        throw new AppError(429, 'TOO_MANY_HOLDS', 'Você já tem 2 pré-reservas abertas; confirme ou cancele uma delas');
      }

      const lamport = await tickLamport(c, clientLamport);
      const { rows } = await c.query(
        `INSERT INTO bookings (room_id, user_id, check_in, check_out, guests, bed_layout, total_price, status,
                               hold_expires_at, idempotency_key, request_hash, lamport, instance_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'HOLD', now() + make_interval(secs => $8), $9,$10,$11,$12)
         RETURNING *`,
        [room.id, user.id, input.checkIn, input.checkOut, input.guests, input.bedLayout, price.total,
         config.holdSeconds, idempotencyKey, hash, lamport, config.instanceId],
      );
      const b = rows[0];
      await appendEvent(c, 'booking.held', { booking: toPublic(b) }, lamport);
      return { booking: toPrivate(b), replayed: false, lamport };
    });
  } catch (err) {
    // Rede de segurança: se alguma requisição escapar da trava, o banco rejeita.
    if (pgCode(err) === PG.EXCLUSION_VIOLATION) {
      throw new AppError(409, 'ROOM_UNAVAILABLE', 'Apartamento indisponível no período (bloqueado pelo banco)');
    }
    if (pgCode(err) === PG.UNIQUE_VIOLATION) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Chave de idempotência já usada com outro conteúdo');
    }
    throw err;
  }
}

async function loadForUpdate(c: Db, bookingId: string) {
  const pre = await c.query('SELECT room_id FROM bookings WHERE id = $1', [bookingId]);
  if (!pre.rows[0]) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Reserva não encontrada');
  await lockRoom(c, pre.rows[0].room_id);
  const { rows } = await c.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
  return rows[0];
}

function receipt(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'HTL-' + Array.from(randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

export async function confirmHold(user: User, bookingId: string, clientLamport: number) {
  return tx(async (c) => {
    const b = await loadForUpdate(c, bookingId);
    if (b.user_id !== user.id) throw new AppError(403, 'FORBIDDEN', 'Esta pré-reserva pertence a outro hóspede');
    if (b.status === 'CONFIRMED') {
      return { booking: toPrivate(b), replayed: true, lamport: await tickLamport(c, clientLamport) };
    }
    if (b.status === 'HOLD' && new Date(b.hold_expires_at) < new Date()) {
      await expireHolds(c, b.room_id);
      throw new AppError(410, 'HOLD_EXPIRED', 'A pré-reserva expirou; o apartamento foi liberado');
    }
    if (b.status !== 'HOLD') throw new AppError(409, 'INVALID_STATE', `Reserva está ${b.status}`);

    const lamport = await tickLamport(c, clientLamport);
    const { rows } = await c.query(
      `UPDATE bookings SET status = 'CONFIRMED', hold_expires_at = NULL, receipt_code = $2,
              version = version + 1, lamport = $3, instance_id = $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [bookingId, receipt(), lamport, config.instanceId],
    );
    await appendEvent(c, 'booking.confirmed', { booking: toPublic(rows[0]) }, lamport);
    return { booking: toPrivate(rows[0]), replayed: false, lamport };
  });
}

export async function cancelBooking(user: User, bookingId: string, clientLamport: number) {
  return tx(async (c) => {
    const b = await loadForUpdate(c, bookingId);
    if (b.user_id !== user.id && user.role !== 'RECEPTION') {
      throw new AppError(403, 'FORBIDDEN', 'Você não pode cancelar a reserva de outro hóspede');
    }
    if (b.status === 'CANCELLED' || b.status === 'EXPIRED') {
      return { booking: toPrivate(b), replayed: true, lamport: await tickLamport(c, clientLamport) };
    }
    const lamport = await tickLamport(c, clientLamport);
    const { rows } = await c.query(
      `UPDATE bookings SET status = 'CANCELLED', hold_expires_at = NULL, version = version + 1,
              lamport = $2, instance_id = $3, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [bookingId, lamport, config.instanceId],
    );
    await appendEvent(c, 'booking.cancelled', { booking: toPublic(rows[0]), by: user.role }, lamport);
    return { booking: toPrivate(rows[0]), replayed: false, lamport };
  });
}

/** Snapshot consistente (mesma transação) das reservas ativas + posição no log de eventos. */
export async function snapshot() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const seq = await lastSeq(c);
    const { rows } = await c.query(
      `SELECT * FROM bookings WHERE status IN ('HOLD','CONFIRMED') AND check_out >= $1::date ORDER BY room_id, check_in`,
      [todayLocal()],
    );
    await c.query('COMMIT');
    return { seq, bookings: rows.map(toPublic) };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function myBookings(user: User) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [user.id]);
  return rows.map(toPrivate);
}

export async function getBooking(id: string) {
  const { rows } = await pool.query(
    'SELECT b.*, u.name AS guest_name FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = $1',
    [id],
  );
  return rows[0] ? { booking: toPrivate(rows[0]), ownerId: rows[0].user_id as string } : null;
}

export async function allBookings() {
  const { rows } = await pool.query(
    `SELECT b.*, u.name AS guest_name FROM bookings b JOIN users u ON u.id = b.user_id
     ORDER BY b.created_at DESC LIMIT 200`,
  );
  return rows.map(toPrivate);
}
