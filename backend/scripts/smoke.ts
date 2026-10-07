/**
 * End-to-end smoke test against a RUNNING stack (API + worker + infra), over real HTTP and WebSockets.
 *   npm run smoke                       (uses http://localhost:4000)
 *   API_URL=http://localhost:8080 npm run smoke
 * Requires the demo seed data (npm run db:seed). Exits non-zero on the first failed step.
 */
import { io } from 'socket.io-client';

const API = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = 'Password123!';

async function call<T = any>(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : (undefined as T) };
}

const login = async (email: string, password = PASSWORD) => {
  const r = await call('POST', '/api/auth/login', undefined, { email, password });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token as string, user: r.body.user };
};

let step = 0;
const ok = (msg: string) => console.log(`  \u2713 ${++step}. ${msg}`);
function must(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error(`  \u2717 FAILED: ${msg}`); process.exit(1); }
}
const until = async (fn: () => Promise<boolean>, ms = 15000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
};

async function main() {
  console.log(`Smoke test against ${API}`);
  const ready = await call('GET', '/health/ready');
  must(ready.status === 200, `readiness failed: ${JSON.stringify(ready.body)}`);
  ok('API ready (Postgres + Redis reachable)');

  const customer = await login('customer1@quickbite.dev');
  const owner = await login('owner1@quickbite.dev');
  const partner = await login('partner1@quickbite.dev');
  const admin = await login('admin@quickbite.dev', 'Admin12345!');
  ok('logged in as customer, restaurant owner, delivery partner, admin');

  const list = await call('GET', '/api/restaurants?q=spice');
  must(list.body.data.length >= 1, 'restaurant search returned nothing (did you run the seed?)');
  const rid = list.body.data[0].id;
  const menu = await call('GET', `/api/restaurants/${rid}`);
  const item = menu.body.restaurant.items.find((i: any) => !i.soldOut && i.isAvailable);
  must(item, 'no orderable item');
  ok(`browsed "${menu.body.restaurant.name}" and picked "${item.name}"`);

  const addrs = await call('GET', '/api/users/me/addresses', customer.token);
  must(addrs.body.addresses.length > 0, 'customer has no address');

  const events: string[] = [];
  const sock = io(API, { auth: { token: customer.token }, transports: ['websocket'] });
  await new Promise<void>((res, rej) => { sock.once('ready', () => res()); sock.once('connect_error', rej); });
  sock.on('order:status', (e: any) => events.push(e.status));
  sock.on('delivery:assigned', () => events.push('ASSIGNED'));
  ok('WebSocket connected with JWT');

  // keep the demo partner available and near the restaurant
  await call('PATCH', '/api/delivery/me/availability', partner.token, { isAvailable: true }).then((r) => {
    if (r.status === 409) return; // still finishing a previous delivery
  });
  await call('PUT', '/api/delivery/me/location', partner.token, { lat: 17.386, lng: 78.487 });

  await call('PUT', '/api/cart/items', customer.token, { menuItemId: item.id, quantity: 2, replaceCart: true });
  const key = `smoke-${Date.now()}`;
  const order = await call('POST', '/api/orders', customer.token, { addressId: addrs.body.addresses[0].id }, { 'Idempotency-Key': key });
  must(order.status === 201, `order failed: ${JSON.stringify(order.body)}`);
  const orderId = order.body.order.id as string;
  const replay = await call('POST', '/api/orders', customer.token, { addressId: addrs.body.addresses[0].id }, { 'Idempotency-Key': key });
  must(replay.status === 200 && replay.body.order.id === orderId, 'idempotent replay did not return the same order');
  ok(`order ${orderId.slice(0, 8)} placed; repeating the same Idempotency-Key replayed it`);
  await new Promise<void>((r) => sock.emit('order:subscribe', orderId, () => r()));

  must(await until(async () => (await call('GET', `/api/orders/${orderId}`, customer.token)).body.order.status === 'PAID'), 'payment worker did not mark order PAID (is the worker running?)');
  ok('payment worker processed the order asynchronously -> PAID');

  for (const s of ['CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP']) {
    const r = await call('POST', `/api/orders/${orderId}/status`, owner.token, { status: s });
    must(r.status === 200, `owner could not set ${s}: ${JSON.stringify(r.body)}`);
  }
  ok('restaurant owner: CONFIRMED -> PREPARING -> READY_FOR_PICKUP');

  must(await until(async () => (await call('GET', `/api/orders/${orderId}`, customer.token)).body.order.delivery !== null), 'no delivery partner was assigned');
  ok('delivery worker auto-assigned a partner');

  for (const s of ['PICKED_UP', 'DELIVERED']) {
    const r = await call('POST', `/api/orders/${orderId}/status`, partner.token, { status: s });
    must(r.status === 200, `partner could not set ${s}: ${JSON.stringify(r.body)}`);
  }
  ok('delivery partner: PICKED_UP -> DELIVERED');

  must(await until(async () => events.includes('DELIVERED')), 'customer socket never received DELIVERED');
  ok(`customer received live updates over WebSocket: ${events.join(' > ')}`);

  const notes = await call('GET', '/api/notifications', customer.token);
  must(notes.body.data.length >= 3, 'expected persisted notifications');
  ok(`${notes.body.unreadCount} unread notifications persisted`);

  const stats = await call('GET', '/api/admin/stats', admin.token);
  must(stats.status === 200 && stats.body.ordersByStatus.DELIVERED >= 1, 'admin stats missing delivered order');
  ok('admin dashboard stats reflect the delivered order');

  const metrics = await (await fetch(`${API}/metrics`)).text();
  must(metrics.includes('http_request_duration_seconds_bucket'), 'metrics missing');
  ok('Prometheus /metrics exposes latency histograms');

  sock.close();
  console.log('\nSMOKE TEST PASSED');
}

main().catch((e) => { console.error('smoke test crashed:', e); process.exit(1); });
