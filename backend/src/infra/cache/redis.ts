import Redis from 'ioredis';
import { env } from '../../config/env';
import { logger } from '../../config/logger';

/** Shared command connection (cache, rate limiting, geo, queue state). */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false, // fail fast when Redis is down: callers degrade gracefully
  lazyConnect: false,
});
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));

/** Pub/sub needs dedicated connections (a subscribed connection can't run other commands). */
export function createRedisClient(): Redis {
  const c = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  c.on('error', (err) => logger.warn({ err: err.message }, 'redis (aux) error'));
  return c;
}

/** Resolves once the shared connection is usable (commands issued earlier would fail fast: offline queue is off). */
export function waitForRedis(timeoutMs = 10_000): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for Redis')), timeoutMs);
    redis.once('ready', () => { clearTimeout(timer); resolve(); });
  });
}

export async function checkRedis(): Promise<void> {
  const pong = await redis.ping();
  if (pong !== 'PONG') throw new Error('unexpected redis reply');
}

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => redis.disconnect());
}
