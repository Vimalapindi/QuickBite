// REALISTIC MIX at a fixed ARRIVAL RATE (open model): 90% browsing, 10% ordering.
// An open model keeps sending requests at the target rate even when the server slows down, which is how real
// traffic behaves and exposes saturation honestly (a closed VU loop would politely slow down with the server).
import http from 'k6/http';
import { BASE, authHeaders, discover, loginCustomers, okJson, uuid, USERS } from './lib.js';

const RATE = Number(__ENV.RATE || 100); // iterations per second

export const options = {
  scenarios: {
    mixed: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      // Each VU runs one iteration at a time and is bound to ONE customer, so concurrent iterations never share a cart.
      // Therefore USERS must be >= maxVUs (seed more with SEED_LOADTEST_USERS). If VUs run out, dropped_iterations > 0 = saturation.
      preAllocatedVUs: Math.min(USERS, 50),
      maxVUs: USERS,
      stages: [
        { duration: '15s', target: RATE },
        { duration: __ENV.HOLD || '45s', target: RATE },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    dropped_iterations: ['count==0'], // if k6 couldn't even start requests fast enough, the system is saturated
  },
};

export function setup() {
  const tokens = loginCustomers();
  const found = discover(tokens);
  const ids = http.get(`${BASE}/api/restaurants?limit=50`).json('data').map((r) => r.id);
  return { tokens, ids, ...found };
}

export default function (d) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  if (Math.random() < 0.9) {
    okJson(http.get(`${BASE}/api/restaurants/${pick(d.ids)}`, { tags: { name: 'GET /restaurants/:id' } }), 'detail');
    if (Math.random() < 0.5) okJson(http.get(`${BASE}/api/search?q=${pick(['biryani', 'pizza', 'grill', 'dish'])}`, { tags: { name: 'GET /search' } }), 'search');
  } else {
    const i = (__VU - 1) % d.tokens.length;
    const { token } = d.tokens[i];
    http.put(`${BASE}/api/cart/items`, JSON.stringify({ menuItemId: pick(d.menu), quantity: 1, replaceCart: true }), authHeaders(token));
    okJson(http.post(`${BASE}/api/orders`, JSON.stringify({ addressId: d.addresses[i] }), authHeaders(token, { 'Idempotency-Key': uuid() })), 'place order');
  }
}
