import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError } from './errors.js';

export type Role = 'GUEST' | 'RECEPTION';

export interface User {
  id: string;
  name: string;
  role: Role;
  expiresAt: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      correlationId: string;
    }
  }
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function createSession(name: string, role: Role, pin?: string) {
  if (role === 'RECEPTION' && !safeEqual(pin ?? '', config.receptionPin)) {
    throw new AppError(401, 'INVALID_PIN', 'PIN da recepção inválido');
  }
  const token = randomBytes(32).toString('base64url');
  const { rows } = await pool.query(
    `INSERT INTO users (name, role, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING id, name, role, expires_at`,
    [name, role, hashToken(token), config.sessionHours],
  );
  const r = rows[0];
  return { token, user: { id: r.id, name: r.name, role: r.role, expiresAt: new Date(r.expires_at).toISOString() } };
}

export async function userFromToken(token: string | undefined): Promise<User> {
  if (!token) throw new AppError(401, 'NO_TOKEN', 'Sessão não informada');
  const { rows } = await pool.query(
    'SELECT id, name, role, expires_at, expires_at < now() AS expired FROM users WHERE token_hash = $1',
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) throw new AppError(401, 'INVALID_TOKEN', 'Sessão inválida');
  if (r.expired) throw new AppError(401, 'TOKEN_EXPIRED', 'Sessão expirada, entre novamente');
  return { id: r.id, name: r.name, role: r.role, expiresAt: new Date(r.expires_at).toISOString() };
}

/** Para a demonstração: força a expiração da credencial atual. */
export async function expireSession(userId: string): Promise<void> {
  await pool.query("UPDATE users SET expires_at = now() - interval '1 second' WHERE id = $1", [userId]);
}

export function correlation(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-correlation-id');
  req.correlationId = incoming && /^[\w-]{6,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  res.setHeader('x-instance-id', config.instanceId);
  next();
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  try {
    req.user = await userFromToken(token);
    next();
  } catch (err) {
    await audit(req, 'AUTHENTICATE', req.path, 'DENIED', (err as AppError).code);
    next(err);
  }
}

export function requireReception(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'RECEPTION') {
    void audit(req, 'REQUIRE_RECEPTION', req.path, 'DENIED');
    return next(new AppError(403, 'FORBIDDEN', 'Apenas a recepção pode executar esta ação'));
  }
  next();
}

/** Registro de auditoria: quem, o quê, sobre qual recurso, com qual resultado. Sem segredos. */
export async function audit(
  req: Request,
  action: string,
  resource: string,
  result: 'ALLOWED' | 'DENIED' | 'OK' | 'CONFLICT' | 'ERROR',
  detail?: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (correlation_id, user_id, user_name, action, resource, result, detail, instance_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.correlationId, req.user?.id ?? null, req.user?.name ?? null, action, resource, result, detail ?? null, config.instanceId],
    );
  } catch (err) {
    console.warn('[audit] falha ao registrar:', (err as Error).message);
  }
}

/** Limite simples de requisições por identidade (controle contra sobrecarga). */
const buckets = new Map<string, { tokens: number; at: number }>();
export function rateLimit(capacity = 40, refillPerSec = 4) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.user?.id ?? req.ip ?? 'anon';
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    if (b.tokens < 1) return next(new AppError(429, 'RATE_LIMITED', 'Muitas requisições, aguarde um instante'));
    b.tokens -= 1;
    buckets.set(key, b);
    next();
  };
}
