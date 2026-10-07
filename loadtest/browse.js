// READ-HEAVY: list restaurants, open a menu, search. Exercises the Redis cache + indexed queries.
// Run:  k6 run loadtest/browse.js            (see loadtest/README.md for how to compare cache on/off)
import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE, okJson } from './lib.js';

const CITIES = ['Hyderabad', 'Bengaluru', 'Chennai', 'Mumbai', 'Delhi'];
const TERMS = ['biryani', 'pizza', 'noodles', 'burger', 'curry', 'royal', 'spicy', 'grill'];
export const apiErrors = new Counter('api_errors');
const listLatency = new Trend('latency_list', true);
const detailLatency = new Trend('latency_detail', true);
const searchLatency = new Trend('latency_search', true);

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || '15s', target: Number(__ENV.VUS || 50) },
        { duration: __ENV.HOLD || '45s', target: Number(__ENV.VUS || 50) },
        { duration: '10s', target: 0 },
      ],
    },
  },
  // Thresholds are YOUR service-level objectives. Tune them to what you measured, then keep them as a regression gate.
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300', 'p(99)<800'],
    latency_detail: ['p(95)<200'],
  },
};

export function setup() {
  const r = http.get(`${BASE}/api/restaurants?limit=50`);
  const ids = r.json('data').map((x) => x.id);
  if (!ids.length) throw new Error('No restaurants. Run: SEED_BULK_RESTAURANTS=300 npm run db:seed');
  return { ids };
}

export default function (data) {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  const l = http.get(`${BASE}/api/restaurants?city=${pick(CITIES)}&limit=20&page=${1 + Math.floor(Math.random() * 3)}`, { tags: { name: 'GET /restaurants' } });
  listLatency.add(l.timings.duration);
  if (!okJson(l, 'list')) apiErrors.add(1);
  sleep(0.2);

  const d = http.get(`${BASE}/api/restaurants/${pick(data.ids)}`, { tags: { name: 'GET /restaurants/:id' } });
  detailLatency.add(d.timings.duration);
  if (!okJson(d, 'detail')) apiErrors.add(1);
  sleep(0.2);

  const s = http.get(`${BASE}/api/search?q=${pick(TERMS)}`, { tags: { name: 'GET /search' } });
  searchLatency.add(s.timings.duration);
  if (!okJson(s, 'search')) apiErrors.add(1);
  sleep(0.3);
}
