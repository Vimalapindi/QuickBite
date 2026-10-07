# QuickBite — Real-Time Food Delivery Platform

A full-stack, production-style food delivery platform built as a **modular monolith**: customers browse and order, restaurants
manage menus and incoming orders, delivery partners are auto-assigned by proximity, and everyone sees order status change **live**.
The focus is backend engineering: transactions, concurrency safety, idempotency, caching, queues, observability and load testing.

| Layer | Tech |
|---|---|
| Frontend | React 19 + TypeScript + Vite (React Router, Socket.IO client) |
| API | Node.js 22 + TypeScript + Express 5, Zod validation, JWT auth, pino logging |
| Database | PostgreSQL 16, Prisma Client over a shared `pg` connection pool |
| Cache / rate limit / geo | Redis 7 (cache-aside, sliding-window limiter in Lua, GEO index for partners) |
| Messaging | RabbitMQ 3.13 (topic exchange, retry queues, dead-letter queue) + transactional outbox |
| Real-time | Socket.IO with Redis adapter + Redis emitter (workers can push to browsers) |
| Observability | prom-client → Prometheus → Grafana (22-panel dashboard provisioned automatically) |
| Testing | Jest + Supertest (real Postgres/Redis/RabbitMQ), k6 load tests, Playwright UI smoke test |
| Packaging | Docker, Docker Compose, nginx, GitHub Actions CI |

## Quick start (Docker)

Requires Docker Desktop (or Docker Engine + Compose v2).

```bash
cp .env.example .env
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:8080 | The web app (nginx serves the React build and proxies `/api` and WebSockets) |
| http://localhost:4000 | API directly (`/health/ready`, `/metrics`) |
| http://localhost:15672 | RabbitMQ management UI (`quickbite` / `quickbite_dev_password`) |
| http://localhost:9090 | Prometheus |
| http://localhost:3000 | Grafana, dashboard **QuickBite Overview** (anonymous viewer enabled; admin/admin to edit) |

The `migrate` service applies the schema and seeds demo data before the API and worker start.

**Demo logins** (password `Password123!` unless noted): `customer1@quickbite.dev`, `owner1@quickbite.dev`,
`partner1@quickbite.dev`, `admin@quickbite.dev` (password `Admin12345!`).

**Try the full flow in 2 minutes:** open three browser windows (one private): customer, owner, partner.
Customer orders a dish → the owner sees it appear and clicks **Accept → Preparing → Ready** → the partner (set *Go online*) is
auto-assigned and clicks **Picked up → Delivered**. The customer's tracker moves live in every step, with no refresh.
Choose *"Payment is declined"* at checkout to see the failure + stock-restoration path.

## Local development (without Docker for the app)

```bash
docker compose -f docker-compose.infra.yml up -d      # Postgres, Redis, RabbitMQ only
cp .env.example .env

cd backend
npm install
npm run prisma:generate
npm run db:migrate && npm run db:seed
npm run dev            # API on :4000      (terminal 1)
npm run dev:worker     # background worker (terminal 2)

cd ../frontend
npm install
npm run dev            # http://localhost:5173 (proxies /api + WebSocket to :4000)  (terminal 3)
```

## Testing

```bash
cd backend
npm run typecheck
npm test                 # 93 tests: unit + integration + end-to-end against real Postgres/Redis/RabbitMQ
npm run smoke            # end-to-end journey over real HTTP + WebSocket against a RUNNING stack (needs seed data)
```

Integration tests use the database `quickbite_test` and Redis db `1`; create it once:
`docker compose exec postgres createdb -U quickbite quickbite_test` (or `createdb` locally). Override with
`TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_RABBITMQ_URL`.

Browser-level test (optional): `pip install playwright && playwright install chromium && python tools/ui_smoke.py`
with the stack and `npm run dev` (frontend) running. It drives three real browser sessions through a complete order.

Load tests: see [docs/LOADTEST.md](docs/LOADTEST.md).

## What's in the box

* **Auth & RBAC**: register/login, scrypt password hashing, JWT, roles `CUSTOMER`, `RESTAURANT_OWNER`, `DELIVERY_PARTNER`, `ADMIN`; admins are never self-registrable.
* **Restaurants & menus**: owner-scoped CRUD with ownership checks, categories, stock tracking, public cached listing with pagination/filters.
* **Search**: restaurants + dishes, case-insensitive substring match served by PostgreSQL trigram GIN indexes.
* **Cart**: one restaurant per cart, quantity/stock/availability validation, concurrency-safe upserts.
* **Orders**: single DB transaction (stock decrement + order + items + history + payment + outbox event), price snapshots, idempotent creation, explicit state machine with per-role permissions.
* **Async pipeline**: transactional outbox → RabbitMQ → payment / delivery / notification workers, with retries and a DLQ.
* **Delivery**: partners go online and stream location; Redis GEO finds the nearest free partner; an atomic claim prevents double assignment.
* **Real-time**: authenticated Socket.IO, per-user / per-order / per-restaurant rooms, live partner location.
* **Notifications**: persisted per user, pushed live, de-duplicated under at-least-once delivery.
* **Admin**: cached stats, order and user management.
* **Hardening**: Helmet, CORS allow-list, body size limits, Zod on every input, Redis rate limiting (global per-IP, strict on auth, per-user on orders), uniform error shape, request IDs, graceful shutdown, liveness vs readiness probes.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/API.md](docs/API.md) for the endpoints.

## Verification status: what was actually run

Built and verified in a Linux sandbox with real PostgreSQL 16, Redis 7 and RabbitMQ 3.12 processes:

| Check | Result |
|---|---|
| Backend `tsc` strict typecheck | passes |
| Jest suite (unit + integration + e2e) | **93 / 93 passing**, repeated runs stable |
| `npm run smoke` against real API + worker processes over HTTP/WebSocket | passes |
| Playwright UI journey (3 browser sessions: customer, owner, partner) | passes (run repeatedly) |
| Frontend `tsc` + `vite build` | passes |
| k6 scripts `browse`, `orders`, `mixed`, `stock-race`, `ratelimit` | all executed successfully against the real stack |
| Grafana dashboard | JSON generated; every referenced metric name verified against live `/metrics`. **Not rendered in Grafana.** |

**Not verified in the build environment** (Docker was unavailable there): `docker compose up`, the Dockerfiles, nginx config and
the Prometheus/Grafana containers. Their YAML parses, but I have not watched them run. If something fails on your machine, see
Troubleshooting and send me the log.

Prisma note: migrations are applied by `backend/scripts/migrate.ts` (plain SQL files in `backend/prisma/migrations`) rather than
`prisma migrate`, because the schema uses features Prisma can't express (partial/trigram indexes, CHECK constraints) and the
build sandbox couldn't download Prisma's migration engine. Prisma Client is used for all queries via the `pg` driver adapter.
`prisma/schema.prisma` and the SQL are kept in sync by hand.

## Measured performance (sandbox) — read before quoting any number

Numbers in [docs/LOADTEST.md](docs/LOADTEST.md) were measured on a shared sandbox machine where k6, the API, the worker,
Postgres, Redis and RabbitMQ all competed for the same CPU. **They demonstrate the methodology and relative effects
(cache on/off, index before/after), not your production capacity. Run the k6 suite on your own machine and report those numbers.**

## Troubleshooting

| Symptom | Fix |
|---|---|
| Port 5432/6379/5672 already in use | Stop the local service or change the left side of the port mapping in compose |
| `Invalid environment configuration` at startup | Copy `.env.example` to `.env` (the error lists the missing keys) |
| Tests: `database "quickbite_test" does not exist` | `createdb -U quickbite quickbite_test` (see Testing) |
| API `503` on `/health/ready` | Postgres or Redis unreachable; check `docker compose ps` |
| Orders stay `PLACED` | The worker isn't running (`docker compose logs worker` / `npm run dev:worker`) |
| Order stuck at `CONFIRMED` | No online partner near the restaurant. Log in as a partner and press *Go online* |
| k6 login gets `429` | Raise `AUTH_RATE_LIMIT_MAX` / `RATE_LIMIT_MAX` for load tests (see LOADTEST.md) |
| `npm run build` fails on `prisma generate` | Needs internet to fetch Prisma engines on first run |

## Project layout

```
QuickBite/
├── docker-compose.yml          full stack            docker-compose.infra.yml   infra only (dev)
├── .env.example                all configuration, documented
├── backend/
│   ├── prisma/                 schema.prisma, SQL migrations, seed.ts
│   ├── scripts/                migrate.ts (runner), smoke.ts (e2e against running stack)
│   ├── src/
│   │   ├── app.ts server.ts worker.ts
│   │   ├── config/             env (Zod, fail-fast), logger
│   │   ├── infra/              db pool, redis + cache, rabbit, outbox, socket.io, metrics
│   │   ├── shared/             AppError, auth/RBAC, rate limiter, error handler, events
│   │   ├── modules/            auth users restaurants search cart orders payments delivery notifications admin health
│   │   └── workers/            outbox relay, consumers, notification rules
│   └── tests/                  unit/ integration/ (incl. workflow.e2e) setup/
├── frontend/                   React + TS + Vite, nginx.conf
├── loadtest/                   k6 scripts + lib
├── monitoring/                 prometheus.yml, Grafana provisioning + generated dashboard
├── tools/ui_smoke.py           Playwright browser journey
└── docs/                       ARCHITECTURE, API, LOADTEST, RESUME_AND_VIVA
```
