import type { Request, RequestHandler } from 'express';
import { env } from '../../config/env';
import { redis } from '../../infra/cache/redis';
import { rateLimitRejections } from '../../infra/metrics/metrics';

/**
 * Sliding-window-log rate limiter in Redis.
 * Each request is a member of a sorted set scored by timestamp; entries older than the window are
 * trimmed, and the request is allowed only if fewer than `limit` remain. The whole check runs as ONE
 * Lua script, so it is atomic across multiple API instances (no read-then-write race).
 * Unlike a fixed window, there's no burst-at-the-boundary loophole.
 * Fails OPEN: if Redis is down we'd rather serve traffic than reject everyone.
 */
const LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, count, tonumber(oldest[2]) + window - now}
end
redis.call('ZADD', KEYS[1], now, now .. '-' .. ARGV[3])
redis.call('PEXPIRE', KEYS[1], window)
return {1, count + 1, 0}
`;

type Limiter = (key: string, windowMs: number, limit: number, nonce: string) => Promise<[number, number, number]>;
redis.defineCommand('slidingWindow', { numberOfKeys: 1, lua: LUA });
const slidingWindow = (redis as unknown as { slidingWindow: Limiter }).slidingWindow.bind(redis);

interface Options {
  scope: string;
  limit: number;
  windowSec?: number;
  /** Defaults to client IP. Use the user id for authenticated, per-user limits. */
  keyBy?: (req: Request) => string;
}

export function rateLimit(opts: Options): RequestHandler {
  const windowMs = (opts.windowSec ?? env.RATE_LIMIT_WINDOW_SEC) * 1000;
  return async (req, res, next) => {
    if (!env.RATE_LIMIT_ENABLED) return next();
    try {
      const id = opts.keyBy ? opts.keyBy(req) : (req.ip ?? 'unknown');
      const nonce = Math.random().toString(36).slice(2, 10);
      const [allowed, count, retryMs] = await slidingWindow(`rl:${opts.scope}:${id}`, windowMs, opts.limit, nonce);
      res.setHeader('RateLimit-Limit', String(opts.limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.limit - Number(count))));
      if (Number(allowed) === 1) return next();

      const retryAfter = Math.max(1, Math.ceil(Number(retryMs) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      rateLimitRejections.inc({ scope: opts.scope });
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: `Too many requests. Retry in ${retryAfter}s.` },
      });
    } catch {
      next(); // fail open
    }
  };
}
