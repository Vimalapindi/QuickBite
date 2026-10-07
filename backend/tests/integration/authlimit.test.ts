process.env.AUTH_RATE_LIMIT_MAX = '3';
import request from 'supertest';
import { createApp } from '../../src/app';
import { closeDb } from '../../src/infra/db/prisma';
import { closeRedis, redis, waitForRedis } from '../../src/infra/cache/redis';

const app = createApp();
beforeAll(async () => { await waitForRedis(); await redis.flushdb(); });
afterAll(async () => { await closeDb(); await closeRedis(); });

it('throttles brute-force login attempts well below the global limit', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await request(app).post('/api/auth/login').send({ email: 'x@y.co', password: 'nope-nope' })).status);
  expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
  expect(codes.slice(3)).toEqual([429, 429, 429]);
});
