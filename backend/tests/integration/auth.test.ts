import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { closeDb, prisma } from '../../src/infra/db/prisma';
import { closeRedis, waitForRedis } from '../../src/infra/cache/redis';
import { bearer, makeUser } from '../helpers';

beforeAll(() => waitForRedis());
const app = createApp();
afterAll(async () => { await closeDb(); await closeRedis(); });
const email = () => `u-${randomUUID()}@test.dev`;

describe('auth', () => {
  it('registers a customer, returns a token and never exposes the hash', async () => {
    const e = email();
    const res = await request(app).post('/api/auth/register').send({ email: e.toUpperCase(), password: 'supersecret1', name: 'Asha' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: e, role: 'CUSTOMER', name: 'Asha' });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(typeof res.body.token).toBe('string');
    const row = await prisma.user.findUnique({ where: { email: e } });
    expect(row?.passwordHash).not.toContain('supersecret1');
  });

  it('creates a delivery partner profile on partner registration', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: email(), password: 'supersecret1', name: 'Ravi', role: 'DELIVERY_PARTNER', vehicleType: 'SCOOTER' });
    expect(res.status).toBe(201);
    const profile = await prisma.deliveryPartnerProfile.findUnique({ where: { userId: res.body.user.id } });
    expect(profile?.vehicleType).toBe('SCOOTER');
  });

  it('refuses self-registration as ADMIN (privilege escalation)', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: email(), password: 'supersecret1', name: 'Evil', role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates input', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'not-an-email', password: 'short', name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects duplicate emails with 409', async () => {
    const e = email();
    await request(app).post('/api/auth/register').send({ email: e, password: 'supersecret1', name: 'A' });
    const res = await request(app).post('/api/auth/register').send({ email: e, password: 'supersecret1', name: 'B' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('logs in with correct credentials and rejects wrong ones identically', async () => {
    const e = email();
    await request(app).post('/api/auth/register').send({ email: e, password: 'supersecret1', name: 'A' });
    const ok = await request(app).post('/api/auth/login').send({ email: e, password: 'supersecret1' });
    expect(ok.status).toBe(200);
    const badPw = await request(app).post('/api/auth/login').send({ email: e, password: 'wrongpassword' });
    const noUser = await request(app).post('/api/auth/login').send({ email: email(), password: 'wrongpassword' });
    expect(badPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(badPw.body.error).toEqual(noUser.body.error); // no user enumeration
  });

  it('blocks disabled accounts from logging in', async () => {
    const e = email();
    const reg = await request(app).post('/api/auth/register').send({ email: e, password: 'supersecret1', name: 'A' });
    await prisma.user.update({ where: { id: reg.body.user.id }, data: { isActive: false } });
    const res = await request(app).post('/api/auth/login').send({ email: e, password: 'supersecret1' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('GET /me requires a valid token', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer('garbage'))).status).toBe(401);
    const { auth, user } = await makeUser('CUSTOMER');
    const res = await request(app).get('/api/auth/me').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });
});

describe('role-based access control', () => {
  it('forbids customers from admin and owner endpoints (403) and anonymous users (401)', async () => {
    const { auth } = await makeUser('CUSTOMER');
    expect((await request(app).get('/api/admin/stats').set(auth)).status).toBe(403);
    expect((await request(app).post('/api/restaurants').set(auth).send({})).status).toBe(403);
    expect((await request(app).get('/api/admin/stats')).status).toBe(401);
  });
  it('allows admins into admin endpoints', async () => {
    const { auth } = await makeUser('ADMIN');
    const res = await request(app).get('/api/admin/stats').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ordersByStatus');
  });
  it('lets admins disable users but not other admins', async () => {
    const admin = await makeUser('ADMIN');
    const victim = await makeUser('CUSTOMER');
    const other = await makeUser('ADMIN');
    expect((await request(app).patch(`/api/admin/users/${victim.user.id}/active`).set(admin.auth).send({ isActive: false })).status).toBe(200);
    expect((await request(app).patch(`/api/admin/users/${other.user.id}/active`).set(admin.auth).send({ isActive: false })).status).toBe(403);
  });
});
