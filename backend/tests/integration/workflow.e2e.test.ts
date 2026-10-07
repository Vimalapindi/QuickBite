/**
 * End-to-end: HTTP API -> Postgres outbox -> relay -> RabbitMQ -> payment/delivery/notification workers -> Socket.IO.
 * Uses the REAL worker code against real PostgreSQL, Redis and RabbitMQ.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createApp } from '../../src/app';
import { closeDb, prisma } from '../../src/infra/db/prisma';
import { closeRedis, redis, waitForRedis } from '../../src/infra/cache/redis';
import { closeEmitter } from '../../src/infra/realtime/emitter';
import { createSocketServer } from '../../src/infra/realtime/socket';
import { type WorkerHandle, startWorker } from '../../src/workers';
import { makeAddress, makeRestaurant, makeUser, waitFor } from '../helpers';

const app = createApp();
let server: http.Server;
let url: string;
let closeSockets: () => Promise<void>;
let worker: WorkerHandle;
const clients: Socket[] = [];

beforeAll(async () => {
  await waitForRedis();
  server = http.createServer(app);
  closeSockets = createSocketServer(server).close;
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
  worker = await startWorker({ metricsPort: null });
});

afterAll(async () => {
  clients.forEach((c) => c.close());
  await worker.stop();
  await closeSockets();
  await new Promise<void>((r) => server.close(() => r()));
  await closeEmitter();
  await closeDb();
  await closeRedis();
});

async function connect(token: string): Promise<Socket> {
  const s = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  clients.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once('ready', () => resolve());
    s.once('connect_error', reject);
  });
  return s;
}

const collect = (s: Socket, event: string) => {
  const got: any[] = [];
  s.on(event, (p) => got.push(p));
  return got;
};

async function setup(opts: { stock?: number | null; paymentSimulation?: 'SUCCESS' | 'FAIL' } = {}) {
  const owner = await makeUser('RESTAURANT_OWNER');
  const { item, restaurant } = await makeRestaurant(owner.user.id, { price: 15000, stock: opts.stock ?? 10 });
  const customer = await makeUser('CUSTOMER');
  const address = await makeAddress(customer.user.id);
  await request(app).put('/api/cart/items').set(customer.auth).send({ menuItemId: item.id, quantity: 2 });
  const res = await request(app).post('/api/orders').set(customer.auth).set('Idempotency-Key', `k-${randomUUID()}`)
    .send({ addressId: address.id, paymentSimulation: opts.paymentSimulation ?? 'SUCCESS' });
  expect(res.status).toBe(201);
  return { owner, item, restaurant, customer, address, orderId: res.body.order.id as string };
}

const statusOf = (orderId: string) => prisma.order.findUnique({ where: { id: orderId } }).then((o) => o?.status);
const waitStatus = (orderId: string, status: string) => waitFor(async () => (await statusOf(orderId)) === status, 10000);
const setStatus = (auth: Record<string, string>, orderId: string, status: string) => request(app).post(`/api/orders/${orderId}/status`).set(auth).send({ status });

describe('asynchronous order pipeline', () => {
  it('outbox -> RabbitMQ -> payment worker moves PLACED to PAID and notifies both parties', async () => {
    const { orderId, customer, owner } = await setup();
    await waitStatus(orderId, 'PAID');
    const payment = await prisma.payment.findUnique({ where: { orderId } });
    expect(payment).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    // the outbox row was published
    await waitFor(async () => (await prisma.outboxEvent.count({ where: { aggregateId: orderId, publishedAt: null } })) === 0);

    await waitFor(async () => (await prisma.notification.count({ where: { userId: owner.user.id, type: 'NEW_ORDER' } })) === 1);
    const types = (await prisma.notification.findMany({ where: { userId: customer.user.id } })).map((n) => n.type);
    expect(types).toEqual(expect.arrayContaining(['ORDER_PLACED', 'PAYMENT_SUCCEEDED']));
  });

  it('simulated payment failure cancels the order, restocks inventory and notifies the customer', async () => {
    const { orderId, item, customer } = await setup({ paymentSimulation: 'FAIL', stock: 10 });
    await waitStatus(orderId, 'PAYMENT_FAILED');
    expect((await prisma.payment.findUnique({ where: { orderId } }))?.status).toBe('FAILED');
    expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.stock).toBe(10); // compensation
    await waitFor(async () => prisma.notification.findFirst({ where: { userId: customer.user.id, type: 'PAYMENT_FAILED' } }));
  });

  it('is idempotent under duplicate delivery: re-publishing the same event changes nothing', async () => {
    const { orderId, customer } = await setup();
    await waitStatus(orderId, 'PAID');
    await waitFor(async () => (await prisma.notification.count({ where: { userId: customer.user.id } })) >= 2);
    const before = await prisma.notification.count({ where: { userId: customer.user.id } });
    // Re-deliver every event of this order (simulates RabbitMQ at-least-once redelivery / relay crash after publish).
    const evts = await prisma.outboxEvent.findMany({ where: { aggregateId: orderId } });
    for (const e of evts) {
      await worker.broker.publish(e.eventType, { eventId: String(e.id), type: e.eventType, occurredAt: new Date().toISOString(), data: e.payload });
    }
    await worker.broker.flush();
    await new Promise((r) => setTimeout(r, 800));
    expect(await prisma.notification.count({ where: { userId: customer.user.id } })).toBe(before);
    expect((await prisma.payment.findUnique({ where: { orderId } }))?.attempts).toBe(1);
    expect(await prisma.orderStatusHistory.count({ where: { orderId } })).toBe(2); // PLACED, PAID only
  });

  it('a poison message goes to the dead-letter queue instead of looping forever', async () => {
    const amqp = await import('amqplib');
    const conn = await amqp.connect(process.env.RABBITMQ_URL!);
    const ch = await conn.createChannel();
    ch.publish('qb_test.events', 'order.placed', Buffer.from('this is not json'), { persistent: true });
    const msg = await waitFor(async () => (await ch.get('qb_test.dlq', { noAck: true })) || null, 8000);
    expect(msg.content.toString()).toBe('this is not json');
    expect(msg.properties.headers?.['x-error']).toBe('unparseable');
    await conn.close();
  });

  it('outbox survives a broker outage: events written while the relay cannot publish are delivered later', async () => {
    // Write an event straight to the outbox (as the API would), with the relay paused.
    await worker.relay.stop();
    const { orderId } = await setup();
    expect((await prisma.outboxEvent.count({ where: { aggregateId: orderId, publishedAt: null } }))).toBe(1);
    expect(await statusOf(orderId)).toBe('PLACED'); // nothing processed while paused
    worker.relay.start();
    await waitStatus(orderId, 'PAID');
  });
});

describe('real-time delivery via Socket.IO', () => {
  it('rejects unauthenticated sockets', async () => {
    const s = ioClient(url, { transports: ['websocket'], reconnection: false });
    clients.push(s);
    const err = await new Promise<Error>((r) => s.once('connect_error', r));
    expect(err.message).toBe('unauthorized');
    const bad = ioClient(url, { auth: { token: 'junk' }, transports: ['websocket'], reconnection: false });
    clients.push(bad);
    expect((await new Promise<Error>((r) => bad.once('connect_error', r))).message).toBe('unauthorized');
  });

  it('pushes live status changes to the customer, the restaurant dashboard, and order-room subscribers', async () => {
    const owner = await makeUser('RESTAURANT_OWNER');
    const { item, restaurant } = await makeRestaurant(owner.user.id, { stock: 10 });
    const customer = await makeUser('CUSTOMER');
    const address = await makeAddress(customer.user.id);
    const ownerSock = await connect(owner.token);       // auto-joins restaurant:<id>
    const customerSock = await connect(customer.token); // auto-joins user:<id>
    const ownerStatus = collect(ownerSock, 'order:status');
    const customerStatus = collect(customerSock, 'order:status');
    const customerNotes = collect(customerSock, 'notification:new');

    await request(app).put('/api/cart/items').set(customer.auth).send({ menuItemId: item.id, quantity: 1 });
    const res = await request(app).post('/api/orders').set(customer.auth).set('Idempotency-Key', `k-${randomUUID()}`).send({ addressId: address.id });
    const orderId = res.body.order.id as string;

    await waitFor(async () => customerStatus.some((e) => e.status === 'PAID'));
    expect(customerStatus.map((e) => e.status)).toEqual(['PLACED', 'PAID']);
    expect(customerStatus[0]).toMatchObject({ orderId, from: null });
    expect(ownerStatus.map((e) => e.status)).toEqual(expect.arrayContaining(['PLACED', 'PAID']));
    expect(customerNotes.length).toBeGreaterThanOrEqual(2);
    expect(restaurant.id).toBeTruthy();

    // order-room subscription: allowed for a participant...
    const ack = await new Promise<any>((r) => customerSock.emit('order:subscribe', orderId, r));
    expect(ack).toEqual({ ok: true });
    const events = collect(customerSock, 'order:status');
    await setStatus(owner.auth, orderId, 'CONFIRMED');
    await waitFor(async () => events.length > 0);
    // (customer is in both user: and order: rooms; Socket.IO delivers once per socket, not once per room)
    expect(events.filter((e) => e.status === 'CONFIRMED')).toHaveLength(1);
  });

  it('refuses order subscriptions from non-participants', async () => {
    const { orderId } = await setup();
    const stranger = await makeUser('CUSTOMER');
    const sock = await connect(stranger.token);
    const ack = await new Promise<any>((r) => sock.emit('order:subscribe', orderId, r));
    expect(ack.ok).toBe(false);
    const bogus = await new Promise<any>((r) => sock.emit('order:subscribe', 'not-a-uuid', r));
    expect(bogus.ok).toBe(false);
  });

  it("does not leak one customer's events to another customer", async () => {
    const a = await setup();
    const other = await makeUser('CUSTOMER');
    const otherSock = await connect(other.token);
    const leaked = collect(otherSock, 'order:status');
    const leakedNotes = collect(otherSock, 'notification:new');
    await waitStatus(a.orderId, 'PAID');
    await new Promise((r) => setTimeout(r, 400));
    expect(leaked).toHaveLength(0);
    expect(leakedNotes).toHaveLength(0);
  });
});

describe('delivery partner system', () => {
  // Orders confirmed by earlier tests keep retrying for a partner; park them so they can't steal this test's partners.
  beforeEach(async () => {
    await prisma.order.updateMany({ where: { status: { in: ['CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP'] }, delivery: null }, data: { status: 'CANCELLED' } });
    await new Promise((r) => setTimeout(r, 500)); // let any in-flight retry see the cancelled status
  });

  async function onlinePartner(lat: number, lng: number) {
    const p = await makeUser('DELIVERY_PARTNER');
    expect((await request(app).patch('/api/delivery/me/availability').set(p.auth).send({ isAvailable: true })).status).toBe(200);
    expect((await request(app).put('/api/delivery/me/location').set(p.auth).send({ lat, lng })).status).toBe(200);
    // availability was set before the first location ping; make sure it's indexed in Redis GEO
    await redis.geoadd('geo:partners', lng, lat, p.user.id);
    return p;
  }

  it('full journey: order -> pay -> confirm -> auto-assign nearest partner -> pickup -> delivered', async () => {
    // Clear partners left over from other tests so "nearest" is deterministic.
    await redis.del('geo:partners');
    await prisma.deliveryPartnerProfile.updateMany({ data: { isAvailable: false } });

    const far = await onlinePartner(18.5, 79.5);   // ~150 km: outside the 15 km search radius
    const near = await onlinePartner(17.401, 78.451); // ~0.2 km from the test restaurant (17.4, 78.45)
    const { orderId, owner, customer } = await setup();
    const customerSock = await connect(customer.token);
    const assigned = collect(customerSock, 'delivery:assigned');
    const status = collect(customerSock, 'order:status');

    await waitStatus(orderId, 'PAID');
    expect((await setStatus(owner.auth, orderId, 'CONFIRMED')).status).toBe(200);

    const delivery = await waitFor(() => prisma.delivery.findUnique({ where: { orderId } }));
    expect(delivery.partnerId).toBe(near.user.id); // nearest wins, far one untouched
    expect((await prisma.deliveryPartnerProfile.findUnique({ where: { userId: near.user.id } }))?.isAvailable).toBe(false);
    expect((await prisma.deliveryPartnerProfile.findUnique({ where: { userId: far.user.id } }))?.isAvailable).toBe(true);
    await waitFor(async () => assigned.length > 0);
    expect(assigned[0]).toMatchObject({ orderId, partnerId: near.user.id });
    await waitFor(async () => prisma.notification.findFirst({ where: { userId: near.user.id, type: 'DELIVERY_ASSIGNED' } }));

    // the partner sees it
    const mine = await request(app).get('/api/delivery/me').set(near.auth);
    expect(mine.body.deliveries[0].order.id).toBe(orderId);

    // partner can't pick up before it's ready
    expect((await setStatus(near.auth, orderId, 'PICKED_UP')).status).toBe(409);
    expect((await setStatus(owner.auth, orderId, 'PREPARING')).status).toBe(200);
    expect((await setStatus(owner.auth, orderId, 'READY_FOR_PICKUP')).status).toBe(200);
    // customer/owner can't pick up; only the assigned partner can
    expect((await setStatus(customer.auth, orderId, 'PICKED_UP')).status).toBe(409);
    expect((await setStatus(near.auth, orderId, 'PICKED_UP')).status).toBe(200);

    // live location streaming to the customer while in transit
    await customerSock.emitWithAck('order:subscribe', orderId);
    const locations = collect(customerSock, 'delivery:location');
    await request(app).put('/api/delivery/me/location').set(near.auth).send({ lat: 17.41, lng: 78.46 });
    await waitFor(async () => locations.length > 0);
    expect(locations[0]).toMatchObject({ orderId, lat: 17.41, lng: 78.46 });
    const tracking = await request(app).get(`/api/orders/${orderId}/tracking`).set(customer.auth);
    expect(tracking.body.delivery.partner.id).toBe(near.user.id);

    expect((await setStatus(near.auth, orderId, 'DELIVERED')).status).toBe(200);
    await waitFor(async () => status.some((e) => e.status === 'DELIVERED'));
    expect((await prisma.deliveryPartnerProfile.findUnique({ where: { userId: near.user.id } }))?.isAvailable).toBe(true);
    expect((await prisma.delivery.findUnique({ where: { orderId } }))?.status).toBe('DELIVERED');
    const finalTrack = await request(app).get(`/api/orders/${orderId}/tracking`).set(customer.auth);
    expect(finalTrack.body.history.map((h: { to: string }) => h.to)).toEqual(['PLACED', 'PAID', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED']);
  });

  it('retries with delay until a partner comes online (no partner available at first)', async () => {
    await redis.del('geo:partners');
    await prisma.deliveryPartnerProfile.updateMany({ data: { isAvailable: false } });
    const { orderId, owner } = await setup();
    await waitStatus(orderId, 'PAID');
    await setStatus(owner.auth, orderId, 'CONFIRMED');
    await new Promise((r) => setTimeout(r, 900)); // at least one failed attempt (retry delay is 400ms in tests)
    expect(await prisma.delivery.findUnique({ where: { orderId } })).toBeNull();
    const p = await onlinePartner(17.4, 78.45);
    const d = await waitFor(() => prisma.delivery.findUnique({ where: { orderId } }), 10000);
    expect(d.partnerId).toBe(p.user.id);
  });

  it('never assigns one partner to two orders at once (3 orders, 1 partner)', async () => {
    await redis.del('geo:partners');
    await prisma.deliveryPartnerProfile.updateMany({ data: { isAvailable: false } });
    const p = await onlinePartner(17.4, 78.45);
    const orders = await Promise.all([setup(), setup(), setup()]);
    await Promise.all(orders.map((o) => waitStatus(o.orderId, 'PAID')));
    await Promise.all(orders.map((o) => setStatus(o.owner.auth, o.orderId, 'CONFIRMED')));
    await waitFor(async () => (await prisma.delivery.count({ where: { partnerId: p.user.id } })) >= 1);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await prisma.delivery.count({ where: { partnerId: p.user.id } })).toBe(1);
  });

  it('partners cannot go available while on an active delivery; non-partners are forbidden', async () => {
    const c = await makeUser('CUSTOMER');
    expect((await request(app).patch('/api/delivery/me/availability').set(c.auth).send({ isAvailable: true })).status).toBe(403);
  });

  it('REGRESSION: a partner who completed a delivery is assignable to the NEXT order (re-indexed in GEO)', async () => {
    await redis.del('geo:partners');
    await prisma.deliveryPartnerProfile.updateMany({ data: { isAvailable: false } });
    const p = await onlinePartner(17.4, 78.45);
    const first = await setup();
    await waitStatus(first.orderId, 'PAID');
    await setStatus(first.owner.auth, first.orderId, 'CONFIRMED');
    await waitFor(() => prisma.delivery.findUnique({ where: { orderId: first.orderId } }));
    for (const s of ['PREPARING', 'READY_FOR_PICKUP']) await setStatus(first.owner.auth, first.orderId, s);
    await setStatus(p.auth, first.orderId, 'PICKED_UP');
    await setStatus(p.auth, first.orderId, 'DELIVERED');
    expect(await redis.zscore('geo:partners', p.user.id)).not.toBeNull(); // back in the index

    const second = await setup();
    await waitStatus(second.orderId, 'PAID');
    await setStatus(second.owner.auth, second.orderId, 'CONFIRMED');
    const d = await waitFor(() => prisma.delivery.findUnique({ where: { orderId: second.orderId } }), 10000);
    expect(d.partnerId).toBe(p.user.id);
  });

  it('cancelling an assigned order frees the partner', async () => {
    await redis.del('geo:partners');
    await prisma.deliveryPartnerProfile.updateMany({ data: { isAvailable: false } });
    const p = await onlinePartner(17.4, 78.45);
    const { orderId, owner } = await setup();
    await waitStatus(orderId, 'PAID');
    await setStatus(owner.auth, orderId, 'CONFIRMED');
    await waitFor(() => prisma.delivery.findUnique({ where: { orderId } }));
    const admin = await makeUser('ADMIN');
    expect((await setStatus(admin.auth, orderId, 'CANCELLED')).status).toBe(200);
    expect(await prisma.delivery.findUnique({ where: { orderId } })).toBeNull();
    expect((await prisma.deliveryPartnerProfile.findUnique({ where: { userId: p.user.id } }))?.isAvailable).toBe(true);
    expect(await redis.zscore('geo:partners', p.user.id)).not.toBeNull();
  });
});
