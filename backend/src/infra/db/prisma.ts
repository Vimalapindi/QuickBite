import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { env } from '../../config/env';
import { registerPoolMetrics } from '../metrics/metrics';

/**
 * Connection pooling: Postgres forks a process per connection, so we cap the pool
 * (DB_POOL_MAX) and let requests queue in Node instead of overwhelming the database.
 * Prisma runs on top of this single shared pg Pool via the driver adapter.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
pool.on('error', () => { /* idle client errors are logged by pg; don't crash the process */ });
registerPoolMetrics(pool);

export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function checkDb(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDb(): Promise<void> {
  await prisma.$disconnect();
  await pool.end().catch(() => undefined);
}
