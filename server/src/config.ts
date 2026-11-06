import { randomBytes } from 'node:crypto';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/hotel',
  receptionPin: process.env.RECEPTION_PIN ?? '1234',
  holdSeconds: Number(process.env.HOLD_SECONDS ?? 120),
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  /** Identificador desta instância do servidor (cada nó do cluster tem o seu). */
  instanceId: process.env.INSTANCE_ID ?? `node-${randomBytes(2).toString('hex')}`,
  timeZone: 'America/Sao_Paulo',
};
