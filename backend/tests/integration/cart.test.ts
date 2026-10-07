import request from 'supertest';
import { createApp } from '../../src/app';
import { closeDb } from '../../src/infra/db/prisma';
import { closeRedis, waitForRedis } from '../../src/infra/cache/redis';
import { makeRestaurant, makeUser } from '../helpers';

const app = createApp();
beforeAll(() => waitForRedis());
afterAll(async () => { await closeDb(); await closeRedis(); });

describe('cart', () => {
  it('adds, updates, totals and removes items', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const c = await makeUser('CUSTOMER');
    const { item } = await makeRestaurant(owner.user.id, { price: 10000 });
    let res = await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: item.id, quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subtotalCents: 20000, deliveryFeeCents: 4000, totalCents: 24000 });
    res = await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: item.id, quantity: 3 });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(3);
    res = await request(app).delete(`/api/cart/items/${item.id}`).set(c.auth);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.totalCents).toBe(0);
  });

  it('enforces one restaurant per cart unless replaceCart is set', async () => {
    const o1 = await makeUser('RESTAURANT_OWNER');
    const o2 = await makeUser('RESTAURANT_OWNER');
    const c = await makeUser('CUSTOMER');
    const a = await makeRestaurant(o1.user.id);
    const b = await makeRestaurant(o2.user.id);
    await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: a.item.id, quantity: 1 });
    const conflict = await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: b.item.id, quantity: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CART_RESTAURANT_MISMATCH');
    const replaced = await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: b.item.id, quantity: 1, replaceCart: true });
    expect(replaced.status).toBe(200);
    expect(replaced.body.restaurant.id).toBe(b.restaurant.id);
    expect(replaced.body.items).toHaveLength(1);
  });

  it('rejects quantity above stock, unavailable items and closed restaurants', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const c = await makeUser('CUSTOMER');
    const { restaurant, item } = await makeRestaurant(owner.user.id, { stock: 3 });
    const over = await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: item.id, quantity: 4 });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('INSUFFICIENT_STOCK');
    await request(app).patch(`/api/menu-items/${item.id}`).set(owner.auth).send({ isAvailable: false });
    expect((await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: item.id, quantity: 1 })).body.error.code).toBe('ITEM_UNAVAILABLE');
    await request(app).patch(`/api/menu-items/${item.id}`).set(owner.auth).send({ isAvailable: true });
    await request(app).patch(`/api/restaurants/${restaurant.id}`).set(owner.auth).send({ isOpen: false });
    expect((await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: item.id, quantity: 1 })).body.error.code).toBe('RESTAURANT_CLOSED');
  });

  it('is customers-only and validates input', async () => {
    const o = await makeUser('RESTAURANT_OWNER');
    expect((await request(app).get('/api/cart').set(o.auth)).status).toBe(403);
    const c = await makeUser('CUSTOMER');
    expect((await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: 'x', quantity: 1 })).status).toBe(400);
    expect((await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: '9b2f0f9c-8a5e-4a3e-9b53-6f1f5f0c9a11', quantity: 99 })).status).toBe(400);
  });

  it('survives concurrent adds from the same user (no duplicate cart / crash)', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const c = await makeUser('CUSTOMER');
    const { item } = await makeRestaurant(owner.user.id);
    const rs = await Promise.all(Array.from({ length: 10 }, () => request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: item.id, quantity: 1 })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const cart = await request(app).get('/api/cart').set(c.auth);
    expect(cart.body.items).toHaveLength(1);
  });
});
