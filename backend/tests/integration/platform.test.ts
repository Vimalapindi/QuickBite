import request from 'supertest';
import { createApp } from '../../src/app';
import { checkDb, closeDb } from '../../src/infra/db/prisma';
import { checkRedis, closeRedis, waitForRedis } from '../../src/infra/cache/redis';
import { clearReadinessChecks, registerReadinessCheck } from '../../src/modules/health/health.registry';

const app = createApp();
beforeAll(() => waitForRedis());
afterAll(async () => { await closeDb(); await closeRedis(); });
afterEach(() => clearReadinessChecks());

describe('health', () => {
  it('liveness returns 200', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
  it('readiness is 200 with REAL postgres + redis checks', async () => {
    registerReadinessCheck('postgres', checkDb);
    registerReadinessCheck('redis', checkRedis);
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok])).toEqual([['postgres', true], ['redis', true]]);
  });
  it('readiness is 503 when a dependency fails', async () => {
    registerReadinessCheck('broken', async () => { throw new Error('connection refused'); });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks[0]).toMatchObject({ ok: false, error: 'connection refused' });
  });
});

describe('platform behaviour', () => {
  it('returns a consistent JSON 404', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
  it('returns 400 INVALID_JSON for malformed bodies', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
  it('returns 413 for oversized bodies', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'x'.repeat(200_000) });
    expect(res.status).toBe(413);
  });
  it('echoes or generates x-request-id', async () => {
    expect((await request(app).get('/health/live').set('x-request-id', 'abc-123')).headers['x-request-id']).toBe('abc-123');
    expect((await request(app).get('/health/live')).headers['x-request-id']).toBeTruthy();
  });
  it('sets security headers and hides x-powered-by', async () => {
    const res = await request(app).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
  it('exposes Prometheus metrics including HTTP histograms', async () => {
    await request(app).get('/health/live');
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_request_duration_seconds');
    expect(res.text).toContain('db_pool_connections');
  });
});
