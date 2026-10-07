// WRITE PATH: each VU is a different customer who builds a cart and places an order (idempotent key per order).
// Exercises transactions, atomic stock updates, the outbox, RabbitMQ and the workers behind the scenes.
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE, authHeaders, discover, loginCustomers, okJson, uuid, USERS } from './lib.js';

const created = new Counter('orders_created');
const replayed = new Counter('orders_replayed');
const orderLatency = new Trend('latency_place_order', true);

export const options = {
  scenarios: {
    orders: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || '15s', target: Math.min(Number(__ENV.VUS || 20), USERS) },
        { duration: __ENV.HOLD || '45s', target: Math.min(Number(__ENV.VUS || 20), USERS) },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    latency_place_order: ['p(95)<500'],
  },
};

export function setup() {
  const tokens = loginCustomers();
  return { tokens, ...discover(tokens) };
}

export default function (d) {
  const i = (__VU - 1) % d.tokens.length;
  const { token } = d.tokens[i];
  const dish = d.menu[Math.floor(Math.random() * d.menu.length)];

  const cart = http.put(`${BASE}/api/cart/items`, JSON.stringify({ menuItemId: dish, quantity: 1 + Math.floor(Math.random() * 3), replaceCart: true }), authHeaders(token));
  okJson(cart, 'cart');

  const res = http.post(`${BASE}/api/orders`, JSON.stringify({ addressId: d.addresses[i] }), authHeaders(token, { 'Idempotency-Key': uuid() }));
  orderLatency.add(res.timings.duration);
  if (okJson(res, 'place order')) (res.json('replayed') ? replayed : created).add(1);

  http.get(`${BASE}/api/orders?limit=5`, authHeaders(token));
  sleep(0.5);
}
