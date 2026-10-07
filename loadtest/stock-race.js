// CONCURRENCY CORRECTNESS under load: many users fight for a few portions. Not a speed test.
// Expected: exactly STOCK orders succeed (201), everything else is a clean 409 OUT_OF_STOCK, zero 5xx, stock never < 0.
// Setup creates its own limited-stock item using the owner demo account.
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { check } from 'k6';
import { BASE, authHeaders, json, loginCustomers, uuid, USERS } from './lib.js';

const STOCK = Number(__ENV.STOCK || 10);
const won = new Counter('race_orders_won');
const soldOut = new Counter('race_orders_sold_out');
const unexpected = new Counter('race_unexpected_responses');

export const options = {
  scenarios: { race: { executor: 'per-vu-iterations', vus: USERS, iterations: 1, maxDuration: '60s' } },
  thresholds: { race_unexpected_responses: ['count==0'], race_orders_won: [`count==${STOCK}`] },
};

export function setup() {
  const tokens = loginCustomers();
  const owner = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: 'loadtest-owner@quickbite.dev', password: 'Password123!' }), json).json('token');
  const rid = http.get(`${BASE}/api/restaurants?q=Loadtest`).json('data.0.id');
  const item = http.post(`${BASE}/api/restaurants/${rid}/items`, JSON.stringify({ name: `Race Dish ${Date.now()}`, priceCents: 5000, stock: STOCK }), authHeaders(owner)).json('item.id');
  const addresses = tokens.map((t) => http.get(`${BASE}/api/users/me/addresses`, authHeaders(t.token)).json('addresses.0.id'));
  // every user puts the SAME scarce item in their cart first (all see stock=STOCK), then everyone checks out together
  tokens.forEach((t) => http.put(`${BASE}/api/cart/items`, JSON.stringify({ menuItemId: item, quantity: 1, replaceCart: true }), authHeaders(t.token)));
  return { tokens, addresses, item, owner, rid };
}

export default function (d) {
  const i = __VU - 1;
  const res = http.post(`${BASE}/api/orders`, JSON.stringify({ addressId: d.addresses[i] }), authHeaders(d.tokens[i].token, { 'Idempotency-Key': uuid() }));
  if (res.status === 201) won.add(1);
  else if (res.status === 409 && res.json('error.code') === 'OUT_OF_STOCK') soldOut.add(1);
  else { unexpected.add(1); console.error(`unexpected ${res.status}: ${res.body}`); }
  check(res, { 'no 5xx': (r) => r.status < 500 });
}

export function teardown(d) {
  const m = http.get(`${BASE}/api/restaurants/${d.rid}/menu/manage`, authHeaders(d.owner)).json('items').find((i) => i.id === d.item);
  console.log(`final stock of the contested item: ${m.stock} (must be 0, never negative)`);
  d.tokens.forEach((t) => http.del(`${BASE}/api/cart`, null, authHeaders(t.token))); // losers still hold the sold-out dish in their carts
  http.patch(`${BASE}/api/menu-items/${d.item}`, JSON.stringify({ isAvailable: false }), authHeaders(d.owner)); // clean up
}
