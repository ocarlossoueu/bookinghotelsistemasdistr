import type { User } from './auth.js';
import { config } from './config.js';
import { pool, tx } from './db.js';
import { AppError, PG, pgCode } from './errors.js';
import { appendEvent, tickLamport } from './events.js';

/**
 * Laboratório de corrida: todos os celulares disparam ao mesmo tempo para "ganhar"
 * o mesmo recurso. No modo SAFE há exclusão mútua; no modo NAIVE o servidor faz
 * "verifica e depois grava" sem trava, com um atraso que simula processamento.
 */
export type LabMode = 'SAFE' | 'NAIVE';

const COUNTDOWN_MS = 6000;

function attemptRow(r: any) {
  return {
    id: r.id,
    roundId: r.round_id,
    userId: r.user_id,
    userName: r.user_name,
    success: r.success,
    lamport: r.lamport,
    instanceId: r.instance_id,
    receivedAt: new Date(r.received_at).toISOString(),
  };
}

function roundRow(r: any) {
  return { id: r.id, mode: r.mode as LabMode, fireAt: new Date(r.fire_at).toISOString(), createdBy: r.created_by };
}

export async function startRound(user: User, mode: LabMode) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO lab_rounds (mode, fire_at, created_by) VALUES ($1, now() + make_interval(secs => $2), $3) RETURNING *`,
      [mode, COUNTDOWN_MS / 1000, user.name],
    );
    const round = roundRow(rows[0]);
    await appendEvent(c, 'lab.round_started', { round });
    return round;
  });
}

export async function currentRound() {
  const { rows } = await pool.query('SELECT * FROM lab_rounds ORDER BY id DESC LIMIT 1');
  if (!rows[0]) return null;
  const att = await pool.query('SELECT * FROM lab_attempts WHERE round_id = $1 ORDER BY received_at', [rows[0].id]);
  return { round: roundRow(rows[0]), attempts: att.rows.map(attemptRow) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function attempt(user: User, roundId: number, clientLamport: number) {
  const { rows } = await pool.query('SELECT * FROM lab_rounds WHERE id = $1', [roundId]);
  const round = rows[0];
  if (!round) throw new AppError(404, 'ROUND_NOT_FOUND', 'Rodada inexistente');
  if (Date.now() < new Date(round.fire_at).getTime() - 250) {
    throw new AppError(425, 'TOO_EARLY', 'A rodada ainda não começou');
  }

  try {
    if (round.mode === 'SAFE') {
      return await tx(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(2, $1)', [roundId]); // seção crítica
        const w = await c.query('SELECT 1 FROM lab_attempts WHERE round_id = $1 AND success', [roundId]);
        const lamport = await tickLamport(c, clientLamport);
        const ins = await c.query(
          `INSERT INTO lab_attempts (round_id, mode, user_id, user_name, success, lamport, instance_id)
           VALUES ($1,'SAFE',$2,$3,$4,$5,$6) RETURNING *`,
          [roundId, user.id, user.name, w.rowCount === 0, lamport, config.instanceId],
        );
        const a = attemptRow(ins.rows[0]);
        await appendEvent(c, 'lab.attempt', { attempt: a, mode: 'SAFE' }, lamport);
        return a;
      });
    }

    // NAIVE: leitura e escrita separadas, sem trava. Condição de corrida proposital.
    const w = await pool.query('SELECT 1 FROM lab_attempts WHERE round_id = $1 AND success', [roundId]);
    const free = w.rowCount === 0;
    await sleep(150 + Math.random() * 350); // "processando pagamento..."
    return await tx(async (c) => {
      const lamport = await tickLamport(c, clientLamport);
      const ins = await c.query(
        `INSERT INTO lab_attempts (round_id, mode, user_id, user_name, success, lamport, instance_id)
         VALUES ($1,'NAIVE',$2,$3,$4,$5,$6) RETURNING *`,
        [roundId, user.id, user.name, free, lamport, config.instanceId],
      );
      const a = attemptRow(ins.rows[0]);
      await appendEvent(c, 'lab.attempt', { attempt: a, mode: 'NAIVE' }, lamport);
      return a;
    });
  } catch (err) {
    if (pgCode(err) === PG.UNIQUE_VIOLATION) throw new AppError(409, 'ALREADY_TRIED', 'Você já participou desta rodada');
    throw err;
  }
}
