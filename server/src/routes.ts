import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { audit, createSession, expireSession, rateLimit, requireAuth, requireReception } from './auth.js';
import { allBookings, cancelBooking, confirmHold, createHold, getBooking, holdInput, myBookings, snapshot } from './bookings.js';
import { config } from './config.js';
import { pool } from './db.js';
import { BASE_PRICE_PER_PERSON, FLOOR_MULTIPLIER, LAYOUTS, ROOMS } from './domain.js';
import { AppError } from './errors.js';
import { eventsAfter } from './events.js';
import { attempt, currentRound, startRound } from './lab.js';

const lamportOf = (req: Request) => Number(req.header('x-lamport') ?? req.body?.lamport ?? 0) || 0;

export function apiRouter(): Router {
  const r = Router();

  r.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, instanceId: config.instanceId, time: Date.now() });
  });

  r.get('/catalog', (_req, res) => {
    res.json({
      basePrice: BASE_PRICE_PER_PERSON,
      floorMultiplier: FLOOR_MULTIPLIER,
      layouts: LAYOUTS,
      rooms: ROOMS,
      holdSeconds: config.holdSeconds,
    });
  });

  r.post('/session', async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(40),
        role: z.enum(['GUEST', 'RECEPTION']).default('GUEST'),
        pin: z.string().max(20).optional(),
      })
      .parse(req.body);
    try {
      const s = await createSession(body.name, body.role, body.pin);
      req.user = s.user;
      await audit(req, 'LOGIN', `role:${body.role}`, 'OK');
      res.status(201).json(s);
    } catch (err) {
      await audit(req, 'LOGIN', `role:${body.role}`, 'DENIED', body.name);
      throw err;
    }
  });

  // ---- daqui para baixo, exige sessão ----
  r.use(requireAuth, rateLimit());

  r.get('/me', (req, res) => res.json({ user: req.user, instanceId: config.instanceId }));

  r.post('/session/expire', async (req, res) => {
    await expireSession(req.user!.id);
    await audit(req, 'EXPIRE_SESSION', `user:${req.user!.id}`, 'OK');
    res.json({ ok: true });
  });

  r.get('/state', async (_req, res) => {
    res.json({ ...(await snapshot()), instanceId: config.instanceId, serverTime: Date.now() });
  });

  r.get('/events', async (req, res) => {
    const after = Number(req.query.after ?? 0) || 0;
    res.json({ events: await eventsAfter(after) });
  });

  r.post('/holds', async (req, res) => {
    const input = holdInput.parse(req.body);
    const key = req.header('idempotency-key');
    if (!key || !/^[\w-]{8,80}$/.test(key)) throw new AppError(400, 'NO_IDEMPOTENCY_KEY', 'Cabeçalho Idempotency-Key obrigatório');
    try {
      const result = await createHold(req.user!, input, key, lamportOf(req));
      await audit(req, 'HOLD', `room:${input.roomId}`, 'OK', result.replayed ? 'replay' : result.booking.id);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) {
      await audit(req, 'HOLD', `room:${input.roomId}`, err instanceof AppError && err.status === 409 ? 'CONFLICT' : 'ERROR', (err as AppError).code);
      throw err;
    }
  });

  r.post('/bookings/:id/confirm', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    try {
      const result = await confirmHold(req.user!, id, lamportOf(req));
      await audit(req, 'CONFIRM', `booking:${id}`, 'OK', result.replayed ? 'replay' : result.booking.receiptCode ?? undefined);
      res.json(result);
    } catch (err) {
      await audit(req, 'CONFIRM', `booking:${id}`, (err as AppError).status === 403 ? 'DENIED' : 'ERROR', (err as AppError).code);
      throw err;
    }
  });

  r.post('/bookings/:id/cancel', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    try {
      const result = await cancelBooking(req.user!, id, lamportOf(req));
      await audit(req, 'CANCEL', `booking:${id}`, 'OK', result.replayed ? 'replay' : undefined);
      res.json(result);
    } catch (err) {
      await audit(req, 'CANCEL', `booking:${id}`, (err as AppError).status === 403 ? 'DENIED' : 'ERROR', (err as AppError).code);
      throw err;
    }
  });

  r.get('/bookings/mine', async (req, res) => {
    res.json({ bookings: await myBookings(req.user!) });
  });

  /** Autorização por objeto: só o dono ou a recepção leem os detalhes de uma reserva. */
  r.get('/bookings/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const found = await getBooking(id);
    if (!found) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Reserva não encontrada');
    const allowed = found.ownerId === req.user!.id || req.user!.role === 'RECEPTION';
    await audit(req, 'READ_BOOKING', `booking:${id}`, allowed ? 'ALLOWED' : 'DENIED');
    if (!allowed) throw new AppError(403, 'FORBIDDEN', 'Acesso negado: a reserva pertence a outro hóspede');
    res.json({ booking: found.booking });
  });

  // ---- laboratório de corrida ----
  r.get('/lab/current', async (_req, res) => res.json(await currentRound()));
  r.post('/lab/rounds', requireReception, async (req, res) => {
    const { mode } = z.object({ mode: z.enum(['SAFE', 'NAIVE']) }).parse(req.body);
    const round = await startRound(req.user!, mode);
    await audit(req, 'LAB_START', `round:${round.id}`, 'OK', mode);
    res.status(201).json({ round, serverTime: Date.now() });
  });
  r.post('/lab/rounds/:id/attempt', async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    res.status(201).json({ attempt: await attempt(req.user!, id, lamportOf(req)) });
  });

  // ---- recepção ----
  r.get('/admin/bookings', requireReception, async (req, res) => {
    await audit(req, 'LIST_ALL_BOOKINGS', 'bookings', 'ALLOWED');
    res.json({ bookings: await allBookings() });
  });
  r.get('/admin/audit', requireReception, async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100');
    res.json({ entries: rows });
  });
  r.get('/admin/instances', async (_req, res) => {
    const { rows } = await pool.query(
      "SELECT id, connected, started_at, last_seen, last_seen > now() - interval '15 seconds' AS alive FROM instances ORDER BY started_at",
    );
    res.json({ instances: rows, self: config.instanceId });
  });

  return r;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION', message: 'Dados inválidos', details: err.issues } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Erro interno' } });
}
