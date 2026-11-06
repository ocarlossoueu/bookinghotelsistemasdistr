import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { userFromToken } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';
import type { EventBus } from './events.js';

/**
 * Canal de tempo real (WebSocket via Socket.IO):
 *  - repassa eventos do log ordenado para todos os celulares;
 *  - responde pings de sincronização de relógio (algoritmo de Cristian);
 *  - publica heartbeat da instância e contagem de conectados.
 */
export function attachRealtime(server: HttpServer, bus: EventBus) {
  const io = new Server(server, { cors: { origin: true }, pingInterval: 10000, pingTimeout: 8000 });

  io.use(async (socket, next) => {
    try {
      const user = await userFromToken(socket.handshake.auth?.token);
      socket.data.user = user;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  let lastPresence: unknown = null;

  io.on('connection', (socket) => {
    socket.emit('hello', { instanceId: config.instanceId, serverTime: Date.now() });
    if (lastPresence) socket.emit('presence', lastPresence);
    socket.on('time:ping', (clientSent: number, ack?: (r: { clientSent: number; serverTime: number }) => void) => {
      if (typeof ack === 'function') ack({ clientSent, serverTime: Date.now() });
    });
  });

  bus.on('event', (e) => io.emit('event', e));

  const heartbeat = async () => {
    try {
      await pool.query(
        `INSERT INTO instances (id, connected, last_seen) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET connected = EXCLUDED.connected, last_seen = now()`,
        [config.instanceId, io.engine.clientsCount],
      );
      const { rows } = await pool.query(
        `SELECT id, connected FROM instances WHERE last_seen > now() - interval '15 seconds' ORDER BY id`,
      );
      lastPresence = {
        instances: rows,
        total: rows.reduce((s: number, r: { connected: number }) => s + r.connected, 0),
        listening: bus.listening,
      };
      io.emit('presence', lastPresence);
    } catch (err) {
      console.warn('[heartbeat]', (err as Error).message);
    }
  };
  void heartbeat();
  const timer = setInterval(heartbeat, 3000);

  return {
    io,
    close: async () => {
      clearInterval(timer);
      await new Promise<void>((r) => io.close(() => r()));
    },
  };
}
