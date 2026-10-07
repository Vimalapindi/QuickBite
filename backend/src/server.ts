import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { closeRedis, checkRedis, waitForRedis } from './infra/cache/redis';
import { checkDb, closeDb } from './infra/db/prisma';
import { closeEmitter } from './infra/realtime/emitter';
import { createSocketServer } from './infra/realtime/socket';
import { registerReadinessCheck } from './modules/health/health.registry';

// The API needs Postgres + Redis. It deliberately does NOT depend on RabbitMQ being up:
// orders are written to the outbox table and published later, so a broker outage doesn't take the API down.
registerReadinessCheck('postgres', checkDb);
registerReadinessCheck('redis', checkRedis);

const app = createApp();
const server = http.createServer(app);
const sockets = createSocketServer(server);

// Don't accept traffic until Redis is connected (rate limiting + cache depend on it).
waitForRedis()
  .then(() => server.listen(env.PORT, () => logger.info(`QuickBite API listening on :${env.PORT} (${env.NODE_ENV})`)))
  .catch((err) => { logger.fatal({ err }, 'startup failed'); process.exit(1); });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown: draining');
  const force = setTimeout(() => { logger.error('shutdown timed out'); process.exit(1); }, 15_000);
  force.unref();
  try {
    await new Promise<void>((resolve) => server.close(() => resolve())); // finish in-flight requests
    await sockets.close();
    await closeEmitter();
    await closeDb();
    await closeRedis();
    logger.info('shutdown: clean');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => { logger.fatal({ reason }, 'unhandledRejection'); process.exit(1); });
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaughtException'); process.exit(1); });
