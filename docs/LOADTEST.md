# Load testing with k6

Install k6 (https://k6.io/docs/get-started/installation/). All scripts take the target from `API_URL` (default `http://localhost:4000`).

## 1. Prepare the stack for load testing

Rate limiting would (correctly) throttle k6, so relax it for throughput tests, keeping everything else production-like:

```bash
# in .env (restart api + worker afterwards)
RATE_LIMIT_MAX=1000000
AUTH_RATE_LIMIT_MAX=1000000
LOG_LEVEL=warn
```
Seed fixtures: `SEED_LOADTEST_USERS=100 SEED_BULK_RESTAURANTS=300 npm run db:seed` (inside `backend/`, or via
`docker compose run --rm -e SEED_LOADTEST_USERS=100 -e SEED_BULK_RESTAURANTS=300 migrate npx tsx prisma/seed.ts`).
This creates 300 restaurants × 25 dishes (7,500 dishes), 100 customers with addresses, and an unlimited-stock "Loadtest Kitchen".

## 2. Scripts

| Script | Model | Proves |
|---|---|---|
| `k6 run loadtest/browse.js` | ramping VUs, read-heavy | latency/throughput of cached reads, indexed search. Env: `VUS`, `RAMP`, `HOLD` |
| `k6 run loadtest/orders.js` | ramping VUs, write path | transactional order placement + outbox + workers. Env: `VUS` (≤ `USERS`), `USERS` |
| `k6 run loadtest/mixed.js` | **open model**, arrival rate | realistic 90/10 read/write mix; `dropped_iterations > 0` = saturation. Env: `RATE`, `USERS` (**must be ≥ the VU cap**) |
| `k6 run loadtest/stock-race.js` | N users, 1 iteration | **correctness under contention**: exactly `STOCK` orders win, zero 5xx, stock ends at 0 |
| `k6 run loadtest/ratelimit.js` | constant arrival rate | 429s appear and rejections are cheap. **Run with default (strict) limits** |

Closed vs open model: `browse`/`orders` use VUs that wait for each response (the load backs off as the server slows).
`mixed` uses an arrival rate (requests keep coming at the target rate regardless), which is how real traffic behaves and
exposes saturation honestly.

## 3. Measuring cache impact yourself
```bash
CACHE_ENABLED=false  → restart API → k6 run loadtest/browse.js     # baseline
CACHE_ENABLED=true   → restart API → k6 run loadtest/browse.js     # with Redis cache
```
Cache hit ratio: Grafana panel *Cache hit ratio*, or `curl localhost:4000/metrics | grep cache_operations_total`.

## 4. Capturing results honestly
1. Run each scenario at least 3 times; report the median run and the machine (CPU cores, RAM, Docker or not).
2. Record: p50/p95/p99 latency, requests/sec, error rate (`http_req_failed`), cache hit ratio, and API/worker CPU and memory from the Grafana *Process resources* row.
3. Increase load until a threshold fails; **the load just before that is your measured capacity**. Report the breaking point too.
4. Save the `k6 run --summary-export=results.json` files in `loadtest/results/`.

Template for your own numbers:

| Scenario | Load | p50 | p95 | p99 | Req/s | Error rate | Notes (machine, cache) |
|---|---|---|---|---|---|---|---|
| browse | __ VUs | | | | | | |
| orders | __ VUs | | | | | | |
| mixed | __ req/s | | | | | | |

## 5. What I measured in the build sandbox (NOT representative of your hardware)

Environment: single shared Linux VM; k6, API, worker, PostgreSQL 16, Redis 7 and RabbitMQ all on the same CPU; 300 restaurants / 7,500 dishes.
Each figure comes from one short run (about 30 s), so treat them as illustrations of *relative* effects.

**Redis cache impact** (`browse.js`, 40 VUs, 20 s hold, API with `CACHE_ENABLED` false vs true):

| | avg | median | p90 | p95 | max | errors |
|---|---|---|---|---|---|---|
| cache off | 61.1 ms | 44.8 ms | 140 ms | 168 ms | 270 ms | 0 / 3,778 |
| cache on | 4.9 ms | 2.5 ms | 9.6 ms | 17.2 ms | 77 ms | 0 / 4,672 |

Cache hit ratio in the cached run: 4,579 hits / (4,579 + 93 misses) = **98.0 %**. (Requests/sec isn't compared here because VUs include think-time sleeps.)

**Concurrency correctness** (`stock-race.js`, 50 users, 10 portions): 10 orders created, 40 clean `409 OUT_OF_STOCK`, 0 unexpected responses, final stock 0.

**Order write path** (`orders.js`, 10 VUs, ~45 s): 205 orders, 0 % failures, order-placement latency avg 117 ms, p95 298 ms (includes a transaction with several round trips, on a contended machine).

**Mixed open-model run** (`mixed.js`, 30 req/s target, 8 s hold, 50 users): 0 % failures, 0 dropped iterations, p95 38 ms.

**Rate limiter** (`ratelimit.js`, 50 req/s for 20 s from one IP): 701 requests rejected with 429; rejected-request p95 2.8 ms (rejections are cheap).

**Query plans** (500,000-row synthetic tables on the same machine, `EXPLAIN (ANALYZE)`):

| Query | Before | After | Change |
|---|---|---|---|
| `ILIKE '%biryani 4242%'` on dish names | 315.6 ms (parallel seq scan) | 2.6 ms (GIN trigram bitmap scan) | ~120× |
| Restaurant orders by `(restaurantId, status)` newest first, LIMIT 20 | 42.4 ms (parallel seq scan) | 0.24 ms (composite index) | ~175× |

Reproduce with `docs/explain-experiments.sql`.

I did not run a sustained high-throughput or soak test, so I make **no claim** about maximum requests/sec or long-run memory behaviour.
Do that on your machine with section 4 and quote only what you measure.
