import amqp from 'amqplib';
import Redis from 'ioredis';
import { migrate } from '../../scripts/migrate';

/** Once per `jest` run: fresh schema, empty Redis db 1, empty RabbitMQ test queues. */
export default async function globalSetup() {
  const dbUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://quickbite:quickbite_dev_password@localhost:5432/quickbite_test';
  await migrate(dbUrl, { reset: true });

  const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1');
  await redis.flushdb();
  redis.disconnect();

  const conn = await amqp.connect(process.env.TEST_RABBITMQ_URL ?? 'amqp://quickbite:quickbite_dev_password@localhost:5672');
  const ch = await conn.createChannel();
  for (const q of ['payment', 'delivery', 'notification']) {
    for (const name of [`qb_test.${q}`, `qb_test.${q}.retry`]) await ch.deleteQueue(name).catch(() => undefined);
  }
  await ch.deleteQueue('qb_test.dlq').catch(() => undefined);
  await ch.close().catch(() => undefined);
  await conn.close();
}
