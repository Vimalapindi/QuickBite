import { logger } from './config/logger';
import { closeRedis } from './infra/cache/redis';
import { closeDb } from './infra/db/prisma';
import { startWorker } from './workers';

async function main() {
  const worker = await startWorker();
  // If the broker connection drops, exit so the container supervisor restarts us with a fresh connection.
  worker.broker.onUnexpectedClose = () => {
    logger.fatal('RabbitMQ connection lost, exiting for restart');
    process.exit(1);
  };

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutdown');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await worker.stop();
    await closeDb();
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => { logger.fatal({ reason }, 'unhandledRejection'); process.exit(1); });
