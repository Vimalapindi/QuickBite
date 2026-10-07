import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { closeDb, prisma } from '../../src/infra/db/prisma';
import { closeRedis, waitForRedis } from '../../src/infra/cache/redis';
import { makeAddress, makeRestaurant, makeUser } from '../helpers';

const app = createApp();
beforeAll(() => waitForRedis());
afterAll(async () => { await closeDb(); await closeRedis(); });

const key = () => `idem-${randomUUID()}`;

async function customerWithCart(itemId: string, quantity = 1) {
  const c = await makeUser('CUSTOMER');
  const address = await makeAddress(c.user.id);
  const r = await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: itemId, quantity });
  if (r.status !== 200) throw new Error(`cart setup failed: ${JSON.stringify(r.body)}`);
  return { ...c, address };
}

describe('order placement (transaction)', () => {
  it('creates an order with price snapshots, history, payment, outbox event, and empties the cart', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item, restaurant } = await makeRestaurant(owner.user.id, { price: 10000, stock: 5 });
    const c = await customerWithCart(item.id, 2);

    const res = await request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', key()).send({ addressId: c.address.id });
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ status: 'PLACED', subtotalCents: 20000, deliveryFeeCents: 4000, totalCents: 24000 });
    expect(res.body.order.items[0]).toMatchObject({ quantity: 2, priceCents: 10000 });

    // price snapshot: changing the menu later must not rewrite history
    await prisma.menuItem.update({ where: { id: item.id }, data: { priceCents: 99999 } });
    const again = await request(app).get(`/api/orders/${res.body.order.id}`).set(c.auth);
    expect(again.body.order.items[0].priceCents).toBe(10000);

    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.stock).toBe(3);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: res.body.order.id } })).toBe(1);
    expect((await prisma.payment.findUnique({ where: { orderId: res.body.order.id } }))?.status).toBe('PENDING');
    const evt = await prisma.outboxEvent.findFirst({ where: { aggregateId: res.body.order.id } });
    expect(evt).toMatchObject({ eventType: 'order.placed', publishedAt: null });
    expect((evt?.payload as { restaurantId: string }).restaurantId).toBe(restaurant.id);
    expect((await request(app).get('/api/cart').set(c.auth)).body.items).toHaveLength(0);
  });

  it('requires an Idempotency-Key header', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item } = await makeRestaurant(owner.user.id);
    const c = await customerWithCart(item.id);
    const res = await request(app).post('/api/orders').set(c.auth).send({ addressId: c.address.id });
    expect(res.status).toBe(400);
  });

  it('rejects empty carts and foreign addresses', async () => {
    const c = await makeUser('CUSTOMER');
    const mine = await makeAddress(c.user.id);
    const empty = await request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', key()).send({ addressId: mine.id });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('CART_EMPTY');

    const owner = await makeUser('RESTAURANT_OWNER');
    const { item } = await makeRestaurant(owner.user.id);
    const c2 = await customerWithCart(item.id);
    const other = await makeAddress(c.user.id);
    const res = await request(app).post('/api/orders').set(c2.auth).set('Idempotency-Key', key()).send({ addressId: other.id });
    expect(res.body.error.code).toBe('ADDRESS_NOT_FOUND');
  });

  it('rolls back EVERYTHING when one line is out of stock (atomicity)', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { restaurant, item: plenty } = await makeRestaurant(owner.user.id, { stock: 10 });
    const scarce = await prisma.menuItem.create({ data: { restaurantId: restaurant.id, name: 'Scarce', priceCents: 5000, stock: 1 } });
    const c = await customerWithCart(plenty.id, 2);
    await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: scarce.id, quantity: 1 });
    await prisma.menuItem.update({ where: { id: scarce.id }, data: { stock: 0 } }); // someone else buys the last one

    const res = await request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', key()).send({ addressId: c.address.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OUT_OF_STOCK');
    // the first line's stock decrement must have been rolled back, and no order / outbox row left behind
    const plentyAfter = await prisma.menuItem.findUnique({ where: { id: plenty.id } });
    expect(plentyAfter?.stock).toBe(10);
    expect(await prisma.order.count({ where: { customerId: c.user.id } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { aggregateType: 'order', payload: { path: ['customerId'], equals: c.user.id } } })).toBe(0);
  });

  it('refuses to order from a closed restaurant', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item, restaurant } = await makeRestaurant(owner.user.id);
    const c = await customerWithCart(item.id);
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { isOpen: false } });
    const res = await request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', key()).send({ addressId: c.address.id });
    expect(res.body.error.code).toBe('RESTAURANT_CLOSED');
  });
});

describe('idempotency', () => {
  it('replays the same order for a repeated key (no double charge, no double stock decrement)', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item } = await makeRestaurant(owner.user.id, { stock: 5 });
    const c = await customerWithCart(item.id, 1);
    const k = key();
    const first = await request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', k).send({ addressId: c.address.id });
    const second = await request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', k).send({ addressId: c.address.id });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await prisma.order.count({ where: { customerId: c.user.id } })).toBe(1);
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.stock).toBe(4);
  });

  it('survives 15 SIMULTANEOUS requests with the same key: exactly one order', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item } = await makeRestaurant(owner.user.id, { stock: 20 });
    const c = await customerWithCart(item.id, 2);
    const k = key();
    const rs = await Promise.all(Array.from({ length: 15 }, () => request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', k).send({ addressId: c.address.id })));
    expect(rs.filter((r) => ![200, 201].includes(r.status)).map((r) => [r.status, r.body.error])).toEqual([]);
    expect(new Set(rs.map((r) => r.body.order.id)).size).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await prisma.order.count({ where: { customerId: c.user.id } })).toBe(1);
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.stock).toBe(18); // decremented once, not 15 times
    expect(await prisma.outboxEvent.count({ where: { aggregateId: rs[0]!.body.order.id } })).toBe(1);
  });

  it('keeps keys scoped per customer', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item } = await makeRestaurant(owner.user.id);
    const a = await customerWithCart(item.id);
    const b = await customerWithCart(item.id);
    const k = key();
    const ra = await request(app).post('/api/orders').set(a.auth).set('Idempotency-Key', k).send({ addressId: a.address.id });
    const rb = await request(app).post('/api/orders').set(b.auth).set('Idempotency-Key', k).send({ addressId: b.address.id });
    expect(ra.body.order.id).not.toBe(rb.body.order.id);
  });
});

describe('concurrent inventory handling', () => {
  it('50 customers race for 10 portions: exactly 10 succeed, stock ends at 0, never negative', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item } = await makeRestaurant(owner.user.id, { stock: 10 });
    // Stock is checked at add-to-cart time too, so build carts first (all see stock=10), then race checkout.
    const customers = await Promise.all(Array.from({ length: 50 }, () => customerWithCart(item.id, 1)));

    const results = await Promise.all(
      customers.map((c) => request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', key()).send({ addressId: c.address.id })),
    );
    const ok = results.filter((r) => r.status === 201);
    const soldOut = results.filter((r) => r.status === 409 && r.body.error.code === 'OUT_OF_STOCK');
    expect(ok).toHaveLength(10);
    expect(soldOut).toHaveLength(40);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.stock).toBe(0);
    expect(await prisma.orderItem.aggregate({ where: { menuItemId: item.id }, _sum: { quantity: true } }).then((a) => a._sum.quantity)).toBe(10);
  });

  it('the database CHECK constraint is the last line of defence against negative stock', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item } = await makeRestaurant(owner.user.id, { stock: 1 });
    await expect(prisma.$executeRaw`UPDATE "MenuItem" SET stock = stock - 5 WHERE id = ${item.id}::uuid`).rejects.toThrow();
  });
});

describe('status transitions & authorization', () => {
  async function paidOrder() {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item, restaurant } = await makeRestaurant(owner.user.id, { stock: 5 });
    const c = await customerWithCart(item.id, 1);
    const res = await request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', key()).send({ addressId: c.address.id });
    const orderId = res.body.order.id as string;
    // act as the payment worker (the real worker is covered in workflow.e2e.test.ts)
    const { processPayment } = await import('../../src/modules/payments/payment.service');
    expect(await processPayment(orderId)).toBe('succeeded');
    expect(await processPayment(orderId)).toBe('skipped'); // idempotent: a redelivered event is a no-op
    return { owner, c, orderId, item, restaurant };
  }

  it('walks the restaurant side of the lifecycle and exposes allowed next states', async () => {
    const { owner, c, orderId } = await paidOrder();
    const view = await request(app).get(`/api/orders/${orderId}`).set(owner.auth);
    expect(view.body.nextStatuses.sort()).toEqual(['CONFIRMED', 'REJECTED']);
    for (const s of ['CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP']) {
      const r = await request(app).post(`/api/orders/${orderId}/status`).set(owner.auth).send({ status: s });
      expect(r.status).toBe(200);
      expect(r.body.order.status).toBe(s);
    }
    const hist = await request(app).get(`/api/orders/${orderId}/tracking`).set(c.auth);
    expect(hist.body.history.map((h: { to: string }) => h.to)).toEqual(['PLACED', 'PAID', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP']);
  });

  it('rejects invalid transitions and the wrong actor', async () => {
    const { owner, c, orderId } = await paidOrder();
    const skip = await request(app).post(`/api/orders/${orderId}/status`).set(owner.auth).send({ status: 'DELIVERED' });
    expect(skip.status).toBe(409);
    expect(skip.body.error.code).toBe('INVALID_TRANSITION');
    const customerConfirms = await request(app).post(`/api/orders/${orderId}/status`).set(c.auth).send({ status: 'CONFIRMED' });
    expect(customerConfirms.status).toBe(409);
    expect((await request(app).post(`/api/orders/${orderId}/status`).set(owner.auth).send({ status: 'NOPE' })).status).toBe(400);
  });

  it('blocks strangers from viewing or changing someone else\'s order (403)', async () => {
    const { orderId } = await paidOrder();
    const stranger = await makeUser('CUSTOMER');
    const otherOwner = await makeUser('RESTAURANT_OWNER');
    expect((await request(app).get(`/api/orders/${orderId}`).set(stranger.auth)).status).toBe(403);
    expect((await request(app).get(`/api/orders/${orderId}/tracking`).set(otherOwner.auth)).status).toBe(403);
    expect((await request(app).post(`/api/orders/${orderId}/status`).set(otherOwner.auth).send({ status: 'CONFIRMED' })).status).toBe(403);
    expect((await request(app).get(`/api/orders/${randomUUID()}`).set(stranger.auth)).status).toBe(404);
  });

  it('customer cancel restocks inventory and refunds the payment', async () => {
    const { c, orderId, item } = await paidOrder();
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.stock).toBe(4);
    const r = await request(app).post(`/api/orders/${orderId}/status`).set(c.auth).send({ status: 'CANCELLED' });
    expect(r.body.order.status).toBe('CANCELLED');
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.stock).toBe(5);
    expect((await prisma.payment.findUnique({ where: { orderId } }))?.status).toBe('REFUNDED');
  });

  it('customer cannot cancel after the restaurant confirmed', async () => {
    const { owner, c, orderId } = await paidOrder();
    await request(app).post(`/api/orders/${orderId}/status`).set(owner.auth).send({ status: 'CONFIRMED' });
    const r = await request(app).post(`/api/orders/${orderId}/status`).set(c.auth).send({ status: 'CANCELLED' });
    expect(r.status).toBe(409);
  });

  it('rejection by the restaurant restocks too', async () => {
    const { owner, orderId, item } = await paidOrder();
    await request(app).post(`/api/orders/${orderId}/status`).set(owner.auth).send({ status: 'REJECTED' });
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.stock).toBe(5);
  });

  it('a cancel racing a confirm has exactly one winner (optimistic concurrency)', async () => {
    const { owner, c, orderId } = await paidOrder();
    const [a, b] = await Promise.all([
      request(app).post(`/api/orders/${orderId}/status`).set(owner.auth).send({ status: 'CONFIRMED' }),
      request(app).post(`/api/orders/${orderId}/status`).set(c.auth).send({ status: 'CANCELLED' }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect([a.status, b.status].filter((s) => s === 409)).toHaveLength(1);
    const final = await prisma.order.findUnique({ where: { id: orderId } });
    expect(['CONFIRMED', 'CANCELLED']).toContain(final?.status);
    expect(await prisma.orderStatusHistory.count({ where: { orderId } })).toBe(3); // PLACED, PAID, + exactly one more
  });
});

describe('order listing', () => {
  it('lists my orders newest first with pagination, and restaurant owners see their restaurant orders', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item, restaurant } = await makeRestaurant(owner.user.id);
    const c = await makeUser('CUSTOMER');
    const address = await makeAddress(c.user.id);
    for (let i = 0; i < 3; i++) {
      await request(app).put('/api/cart/items').set(c.auth).send({ menuItemId: item.id, quantity: 1 });
      await request(app).post('/api/orders').set(c.auth).set('Idempotency-Key', key()).send({ addressId: address.id });
    }
    const mine = await request(app).get('/api/orders').set(c.auth).query({ limit: 2 });
    expect(mine.body.data).toHaveLength(2);
    expect(mine.body.meta.total).toBe(3);
    const theirs = await request(app).get(`/api/orders/restaurant/${restaurant.id}`).set(owner.auth);
    expect(theirs.body.meta.total).toBe(3);
    const stranger = await makeUser('RESTAURANT_OWNER');
    expect((await request(app).get(`/api/orders/restaurant/${restaurant.id}`).set(stranger.auth)).status).toBe(403);
  });
});
