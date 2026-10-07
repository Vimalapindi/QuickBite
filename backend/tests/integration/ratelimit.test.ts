import { randomUUID } from 'node:crypto';
import request from 'supertest';

// Needs its own tiny limits, so set them BEFORE the app/env module is loaded.
process.env.RATE_LIMIT_MAX = '8';
process.env.AUTH_RATE_LIMIT_MAX = '3';

import { createApp } from '../../src/app';
import { closeDb } from '../../src/infra/db/prisma';
import { closeRedis, redis, waitForRedis } from '../../src/infra/cache/redis';
import { registry } from '../../src/infra/metrics/metrics';
import { rateLimit } from '../../src/shared/middleware/rateLimit';
import express from 'express';

const app = createApp();
beforeAll(async () => { await waitForRedis(); await redis.flushdb(); });
afterAll(async () => { await closeDb(); await closeRedis(); });

describe('rate limiting (Redis sliding window)', () => {
  it('allows up to the limit then returns 429 with Retry-After and a consistent error body', async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 200) + 1}`;
    const codes: number[] = [];
    let last: request.Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await request(app).get('/api/restaurants').set('X-Forwarded-For', ip);
      codes.push(last.status);
    }
    // TRUST_PROXY=0 means every supertest request shares one client IP, so the global bucket is shared.
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(3);
    expect(codes.indexOf(429)).toBeLessThanOrEqual(8);
    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe('RATE_LIMITED');
    expect(Number(last!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(last!.headers['ratelimit-limit']).toBe('8');
    expect(last!.headers['ratelimit-remaining']).toBe('0');
  });

  it('records rejections in Prometheus metrics', async () => {
    const m = await registry.getSingleMetricAsString('rate_limit_rejections_total');
    expect(m).toMatch(/rate_limit_rejections_total\{scope="global"\} [1-9]/);
  });

  it('does not rate-limit health or metrics endpoints', async () => {
    for (let i = 0; i < 15; i++) expect((await request(app).get('/health/live')).status).toBe(200);
    expect((await request(app).get('/metrics')).status).toBe(200);
  });
});

describe('limiter internals (isolated express app)', () => {
  const mk = (limit: number, windowSec: number) => {
    const a = express();
    a.use(rateLimit({ scope: `t-${randomUUID()}`, limit, windowSec, keyBy: (req) => String(req.headers['x-user']) }));
    a.get('/', (_req, res) => { res.json({ ok: true }); });
    return a;
  };

  it('keeps separate budgets per key', async () => {
    const a = mk(2, 30);
    expect((await request(a).get('/').set('x-user', 'alice')).status).toBe(200);
    expect((await request(a).get('/').set('x-user', 'alice')).status).toBe(200);
    expect((await request(a).get('/').set('x-user', 'alice')).status).toBe(429);
    expect((await request(a).get('/').set('x-user', 'bob')).status).toBe(200);
  });

  it('is a SLIDING window: capacity returns as old requests age out', async () => {
    const a = mk(2, 1);
    await request(a).get('/').set('x-user', 'u');
    await request(a).get('/').set('x-user', 'u');
    expect((await request(a).get('/').set('x-user', 'u')).status).toBe(429);
    await new Promise((r) => setTimeout(r, 1150));
    expect((await request(a).get('/').set('x-user', 'u')).status).toBe(200);
  });

  it('is atomic under concurrency: 40 parallel requests against a limit of 10 admit exactly 10', async () => {
    const a = mk(10, 30);
    const rs = await Promise.all(Array.from({ length: 40 }, () => request(a).get('/').set('x-user', 'burst')));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(10);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(30);
  });
});
