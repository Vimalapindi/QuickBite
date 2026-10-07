// Verifies the rate limiter protects the API: a single IP hammering /api should start getting 429s.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE } from './lib.js';

const limited = new Counter('responses_429');
export const options = {
  scenarios: { hammer: { executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s', duration: '20s', preAllocatedVUs: 20 } },
  thresholds: { responses_429: ['count>0'], 'http_req_duration{status:429}': ['p(95)<50'] }, // rejections must be CHEAP
};
export default function () {
  const r = http.get(`${BASE}/api/restaurants`);
  if (r.status === 429) limited.add(1);
  check(r, { 'is 200 or 429': (x) => x.status === 200 || x.status === 429 });
}
