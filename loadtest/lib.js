import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE = __ENV.API_URL || 'http://localhost:4000';
export const USERS = Number(__ENV.USERS || 50);
export const PASSWORD = 'Password123!';
export const json = { headers: { 'Content-Type': 'application/json' } };

export function authHeaders(token, extra = {}) {
  return { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra } };
}

/** Logs in USERS pre-seeded customers ONCE (setup runs once, not per VU), so scrypt cost is not part of the measured load. */
export function loginCustomers() {
  const tokens = [];
  for (let i = 1; i <= USERS; i++) {
    const r = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: `loadtest-user${i}@quickbite.dev`, password: PASSWORD }), json);
    if (r.status !== 200) fail(`login loadtest-user${i} failed (${r.status}). Seed first: SEED_LOADTEST_USERS=${USERS} npm run db:seed. If it's a 429, set AUTH_RATE_LIMIT_MAX high for the load test.`);
    tokens.push({ token: r.json('token'), userId: r.json('user.id') });
  }
  return tokens;
}

/** Discovers the load-test restaurant + dishes + each user's address via the public/authenticated API. */
export function discover(tokens) {
  const list = http.get(`${BASE}/api/restaurants?q=Loadtest`);
  const restaurantId = list.json('data.0.id');
  if (!restaurantId) fail('Loadtest Kitchen not found. Run: SEED_LOADTEST_USERS=50 npm run db:seed');
  // Only the unlimited-stock dishes (the stock-race script creates its own scarce dish in the same restaurant).
  const menu = http.get(`${BASE}/api/restaurants/${restaurantId}`).json('restaurant.items').filter((i) => i.name.indexOf('Loadtest Dish') === 0 && !i.soldOut).map((i) => i.id);
  const addresses = tokens.map((t) => http.get(`${BASE}/api/users/me/addresses`, authHeaders(t.token)).json('addresses.0.id'));
  return { restaurantId, menu, addresses };
}

export function okJson(res, name) {
  return check(res, { [`${name}: status 2xx`]: (r) => r.status >= 200 && r.status < 300 });
}

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
