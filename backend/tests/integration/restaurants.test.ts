import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { closeDb, prisma } from '../../src/infra/db/prisma';
import { closeRedis, redis, waitForRedis } from '../../src/infra/cache/redis';
import { registry } from '../../src/infra/metrics/metrics';
import { makeRestaurant, makeUser } from '../helpers';

const app = createApp();
beforeAll(() => waitForRedis());
afterAll(async () => { await closeDb(); await closeRedis(); });

async function cacheCount(cache: string, result: string): Promise<number> {
  const m = await registry.getSingleMetricAsString('cache_operations_total');
  const line = m.split('\n').find((l) => l.includes(`cache="${cache}"`) && l.includes(`result="${result}"`));
  return line ? Number(line.split(' ').pop()) : 0;
}

const body = { name: 'Biryani House', cuisine: 'Indian', city: 'Hyderabad', address: '1 Main Rd', lat: 17.4, lng: 78.4 };

describe('restaurant management & ownership', () => {
  it('lets an owner create a restaurant, categories and items', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const r = await request(app).post('/api/restaurants').set(owner.auth).send(body);
    expect(r.status).toBe(201);
    const id = r.body.restaurant.id;
    const cat = await request(app).post(`/api/restaurants/${id}/categories`).set(owner.auth).send({ name: 'Mains' });
    expect(cat.status).toBe(201);
    const item = await request(app).post(`/api/restaurants/${id}/items`).set(owner.auth).send({ name: 'Dum Biryani', priceCents: 25000, categoryId: cat.body.category.id, stock: 10 });
    expect(item.status).toBe(201);
    const detail = await request(app).get(`/api/restaurants/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.restaurant.items[0]).toMatchObject({ name: 'Dum Biryani', soldOut: false });
    expect(detail.body.restaurant.items[0].stock).toBeUndefined(); // exact inventory is private
  });

  it("prevents owners from touching another owner's restaurant or items (403)", async () => {
    const a = await makeUser('RESTAURANT_OWNER');
    const b = await makeUser('RESTAURANT_OWNER');
    const { restaurant, item } = await makeRestaurant(a.user.id);
    expect((await request(app).patch(`/api/restaurants/${restaurant.id}`).set(b.auth).send({ name: 'Hijacked' })).status).toBe(403);
    expect((await request(app).post(`/api/restaurants/${restaurant.id}/items`).set(b.auth).send({ name: 'X', priceCents: 100 })).status).toBe(403);
    expect((await request(app).patch(`/api/menu-items/${item.id}`).set(b.auth).send({ priceCents: 1 })).status).toBe(403);
    expect((await request(app).delete(`/api/menu-items/${item.id}`).set(b.auth)).status).toBe(403);
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.priceCents).toBe(20000);
  });

  it('validates menu input', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { restaurant } = await makeRestaurant(owner.user.id);
    const res = await request(app).post(`/api/restaurants/${restaurant.id}/items`).set(owner.auth).send({ name: 'Bad', priceCents: -5 });
    expect(res.status).toBe(400);
    expect((await request(app).get('/api/restaurants/not-a-uuid')).status).toBe(400);
    expect((await request(app).get(`/api/restaurants/${randomUUID()}`)).status).toBe(404);
  });

  it('lets an owner see exact stock on the private manage endpoint only', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { restaurant } = await makeRestaurant(owner.user.id, { stock: 7 });
    const res = await request(app).get(`/api/restaurants/${restaurant.id}/menu/manage`).set(owner.auth);
    expect(res.status).toBe(200);
    expect(res.body.items[0].stock).toBe(7);
  });
});

describe('listing, pagination & filtering', () => {
  it('filters by city/cuisine and paginates', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const city = `City${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 5; i++) await makeRestaurant(owner.user.id, { city, name: `Place ${i}` });
    const p1 = await request(app).get('/api/restaurants').query({ city, limit: 2, page: 1 });
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.meta).toMatchObject({ total: 5, totalPages: 3, page: 1 });
    const p3 = await request(app).get('/api/restaurants').query({ city, limit: 2, page: 3 });
    expect(p3.body.data).toHaveLength(1);
    expect((await request(app).get('/api/restaurants').query({ city: city.toUpperCase() })).body.meta.total).toBe(5); // case-insensitive
    expect((await request(app).get('/api/restaurants').query({ limit: 500 })).status).toBe(400);
  });
});

describe('Redis caching (cache-aside)', () => {
  it('serves the second identical request from cache and records hit/miss metrics', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { restaurant } = await makeRestaurant(owner.user.id);
    const missBefore = await cacheCount('restaurant_detail', 'miss');
    const hitBefore = await cacheCount('restaurant_detail', 'hit');
    await request(app).get(`/api/restaurants/${restaurant.id}`);
    await request(app).get(`/api/restaurants/${restaurant.id}`);
    await request(app).get(`/api/restaurants/${restaurant.id}`);
    expect((await cacheCount('restaurant_detail', 'miss')) - missBefore).toBe(1);
    expect((await cacheCount('restaurant_detail', 'hit')) - hitBefore).toBe(2);
    expect(await redis.ttl(`restaurant:${restaurant.id}:detail`)).toBeGreaterThan(0); // always has a TTL
  });

  it('proves it is really cached: a direct DB change stays invisible until invalidated', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { restaurant } = await makeRestaurant(owner.user.id, { name: 'Original Name' });
    await request(app).get(`/api/restaurants/${restaurant.id}`);
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { name: 'Changed Behind Cache' } });
    expect((await request(app).get(`/api/restaurants/${restaurant.id}`)).body.restaurant.name).toBe('Original Name');
  });

  it('invalidates the detail cache when the owner edits through the API', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { restaurant, item } = await makeRestaurant(owner.user.id);
    await request(app).get(`/api/restaurants/${restaurant.id}`);
    await request(app).patch(`/api/menu-items/${item.id}`).set(owner.auth).send({ priceCents: 12345 });
    const after = await request(app).get(`/api/restaurants/${restaurant.id}`);
    expect(after.body.restaurant.items[0].priceCents).toBe(12345);
    await request(app).patch(`/api/restaurants/${restaurant.id}`).set(owner.auth).send({ name: 'Renamed' });
    expect((await request(app).get(`/api/restaurants/${restaurant.id}`)).body.restaurant.name).toBe('Renamed');
  });

  it('invalidates list pages via the version counter when a restaurant is created', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const city = `VerCity${randomUUID().slice(0, 6)}`;
    expect((await request(app).get('/api/restaurants').query({ city })).body.meta.total).toBe(0); // cached empty page
    await request(app).post('/api/restaurants').set(owner.auth).send({ ...body, city });
    expect((await request(app).get('/api/restaurants').query({ city })).body.meta.total).toBe(1);
  });

  it('coalesces concurrent cache misses into ONE database load (stampede protection)', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { restaurant } = await makeRestaurant(owner.user.id);
    const spy = jest.spyOn(prisma.restaurant, 'findUnique');
    const results = await Promise.all(Array.from({ length: 25 }, () => request(app).get(`/api/restaurants/${restaurant.id}`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2); // not 25
    spy.mockRestore();
  });
});

describe('food search', () => {
  it('finds restaurants and dishes case-insensitively and by substring', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const token = randomUUID().slice(0, 8);
    const { restaurant } = await makeRestaurant(owner.user.id, { name: `Zorba ${token} Grill` });
    await prisma.menuItem.create({ data: { restaurantId: restaurant.id, name: `Smoky Paneer ${token} Tikka`, priceCents: 15000 } });
    const res = await request(app).get('/api/search').query({ q: token.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body.restaurants.map((r: { id: string }) => r.id)).toContain(restaurant.id);
    expect(res.body.items[0]).toMatchObject({ restaurantId: restaurant.id });
  });
  it('requires a query of at least 2 characters', async () => {
    expect((await request(app).get('/api/search').query({ q: 'a' })).status).toBe(400);
  });
  it('uses the trigram index for ILIKE (EXPLAIN shows an index scan when forced)', async () => {
    // With tiny tables Postgres prefers a seq scan. Disabling seqscan shows the index CAN serve the query.
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN SELECT id FROM "MenuItem" WHERE name ILIKE '%biryani%'`);
    });
    expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/MenuItem_name_trgm_idx/);
  });
});
