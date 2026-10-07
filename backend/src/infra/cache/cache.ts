import { env } from '../../config/env';
import { cacheOps } from '../metrics/metrics';
import { redis } from './redis';

/**
 * Cache-aside with three protections:
 *  1. TTL on every key (bounded staleness even if invalidation is missed).
 *  2. Single-flight: concurrent misses for the same key share ONE database call
 *     (prevents a cache stampede on a hot key right after expiry).
 *  3. Redis failure degrades to "always miss", it never breaks the request.
 *
 * Invalidation uses version counters: list/search keys embed `ver`, and bumping the
 * counter instantly orphans every old page without scanning/deleting keys.
 */
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  cacheName: string,
  key: string,
  ttlSec: number,
  loader: () => Promise<T>,
): Promise<T> {
  if (!env.CACHE_ENABLED) return loader();

  try {
    const hit = await redis.get(key);
    if (hit !== null) {
      cacheOps.inc({ cache: cacheName, result: 'hit' });
      return JSON.parse(hit) as T;
    }
    cacheOps.inc({ cache: cacheName, result: 'miss' });
  } catch {
    cacheOps.inc({ cache: cacheName, result: 'error' });
    return loader();
  }

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const p = (async () => {
    try {
      const value = await loader();
      // Add up to 10% jitter so many keys written together don't all expire together.
      const jitter = Math.floor(ttlSec * 0.1 * Math.random());
      await redis.set(key, JSON.stringify(value), 'EX', ttlSec + jitter).catch(() => undefined);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export async function getVersion(name: string): Promise<string> {
  try {
    return (await redis.get(`cachever:${name}`)) ?? '0';
  } catch {
    return '0';
  }
}

export async function bumpVersion(name: string): Promise<void> {
  await redis.incr(`cachever:${name}`).catch(() => undefined);
}

export async function invalidate(...keys: string[]): Promise<void> {
  if (keys.length) await redis.del(...keys).catch(() => undefined);
}
