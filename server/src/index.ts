import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { correlation } from './auth.js';
import { sweepExpiredHolds } from './bookings.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { EventBus } from './events.js';
import { apiRouter, errorHandler } from './routes.js';
import { attachRealtime } from './socket.js';

export async function startServer(port = config.port) {
  await migrate();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '32kb' }));
  app.use(correlation);
  app.use('/api', apiRouter());
  app.use('/api', errorHandler);

  // Front-end React compilado (client/dist) servido pelo mesmo processo.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.resolve(here, '../../client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, { maxAge: '1h', index: false }));
    app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  const server = createServer(app);
  const bus = new EventBus();
  await bus.start();
  const realtime = attachRealtime(server, bus);

  const sweeper = setInterval(() => {
    sweepExpiredHolds().catch((err) => console.warn('[sweeper]', err.message));
  }, 3000);

  await new Promise<void>((resolve) => server.listen(port, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`[${config.instanceId}] ouvindo em http://localhost:${actualPort}`);

  return {
    port: actualPort,
    close: async () => {
      clearInterval(sweeper);
      await realtime.close();
      await bus.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer()
    .then((s) => {
      const shutdown = async () => {
        await s.close();
        await pool.end();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error('Falha ao iniciar:', err);
      process.exit(1);
    });
}
