# Architecture

## Shape

A **modular monolith**: one codebase, two processes (API and worker). Modules under `backend/src/modules` own their routes,
services and schemas and talk to each other through services or events, so any could be extracted later.

```
 React SPA ─HTTP─►  nginx ─► Express API ──► PostgreSQL (source of truth)
     ▲  ▲                       │  ▲          Redis  (cache, rate limit, GEO, socket adapter)
     │  └─WebSocket (Socket.IO)─┘  │
     │                             │ outbox row (same DB transaction as the business change)
     │                             ▼
     │                    Worker process:  outbox relay ──► RabbitMQ (topic exchange)
     │                                                        ├─ payment queue ─► simulated gateway
     └─ Redis pub/sub ◄── Redis emitter ◄───────────────────── ├─ delivery queue ─► nearest-partner assignment
                                                               └─ notification queue ─► persist + push
 Prometheus scrapes /metrics of API and worker ─► Grafana
```

## Request path (layered)

`route → Zod parse → controller/service → Prisma/Redis`. Errors are thrown as `AppError` (or Zod errors) and mapped to one
JSON shape `{ error: { code, message, details? } }` by a single error handler. Express 5 forwards async errors automatically.

## The order lifecycle (core of the project)

```
PLACED → PAID → CONFIRMED → PREPARING → READY_FOR_PICKUP → PICKED_UP → DELIVERED
   │       ├─► REJECTED (restaurant)           CANCELLED: customer before CONFIRMED, admin later
   └─► PAYMENT_FAILED
```
`orderStateMachine.ts` is a table of `from → to → permitted actors`. Anything not listed is rejected with
`409 INVALID_TRANSITION` (and the response lists what *is* allowed). Actors are resolved **per order** (a restaurant owner is
`RESTAURANT` only for their own restaurant; a partner is `PARTNER` only for the delivery assigned to them).

### Placing an order: one transaction
1. Replay check: `(customerId, idempotencyKey)` already exists → return the original order (HTTP 200, `replayed: true`).
2. `BEGIN`; validate address, cart, restaurant open.
3. For each tracked-stock line (sorted by id to keep lock order consistent): `UPDATE "MenuItem" SET stock = stock - $q WHERE id = $id AND stock >= $q`.
   Zero rows updated → `409 OUT_OF_STOCK` and the whole transaction rolls back.
4. Insert order, items (**price snapshots**), status history, payment (`PENDING`), and an `OutboxEvent`; empty the cart. `COMMIT`.

Why this is safe under concurrency: Postgres row-locks the `MenuItem` row during the conditional UPDATE, so concurrent orders are
serialised on that row; once stock reaches 0 the `WHERE` no longer matches. A `CHECK (stock >= 0)` constraint is the last line of defence.
The test suite proves it: 50 simultaneous customers, 10 portions → exactly 10 succeed, 40 get a clean 409, stock ends at 0.

Idempotency under a race: if two requests with the same key run simultaneously, the unique index makes one insert fail; that
request catches the unique violation and returns the winner's order. Tested with 15 parallel identical requests → exactly one order, stock decremented once.

### Status changes
`applyTransition` runs inside a transaction: validate with the state machine → `UPDATE ... WHERE id AND status = <expected>`
(optimistic concurrency: if a customer cancels while the restaurant confirms, exactly one wins and the other gets 409) →
history row → compensation (cancel/reject/payment-failed restock inventory and refund a successful payment) → outbox event.

## Transactional outbox

Writing to Postgres and publishing to RabbitMQ can't be atomic. So the event is inserted into `OutboxEvent` **in the same transaction**.
The relay (worker process) repeatedly: `SELECT ... WHERE publishedAt IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED` →
publish with publisher confirms → mark published, in one transaction. Properties:
* No lost events (a broker outage just grows the backlog; the API keeps working. The API's readiness doesn't depend on RabbitMQ).
* **At-least-once** delivery (crash after publish, before commit → re-publish), so **every consumer is idempotent**:
  payment uses a conditional `status = PENDING` update; notifications have a unique `(userId, eventId)`; assignment skips orders that already have a delivery.
* `SKIP LOCKED` lets multiple relay instances run in parallel without double-publishing.
* A partial index (`WHERE publishedAt IS NULL`) keeps the poll query tiny however many rows accumulate; published rows are deleted after an hour.

## RabbitMQ topology

Durable topic exchange `quickbite.events`; routing keys `order.<status>` and `delivery.assigned`. Three durable queues:
`payment` (←`order.placed`), `delivery` (←`order.confirmed`), `notification` (←`order.*`, `delivery.*`).
Reliability: persistent messages, manual ack + `prefetch`, and **retry-with-delay**: a failed message is republished to
`<queue>.retry`, a TTL queue that dead-letters back to the work queue; after `maxAttempts` it lands in `quickbite.dlq`.
Unparseable messages go straight to the DLQ. The delivery queue deliberately uses retry to wait for a free partner.

## Redis usage (each is a genuine Redis strength)

| Use | Mechanism |
|---|---|
| Menu/restaurant/search cache | Cache-aside, TTL + jitter, **single-flight** (concurrent misses share one DB call), fails open to the DB |
| Cache invalidation | Detail keys are deleted on write; list/search keys embed a version counter that is `INCR`'d, orphaning every old page at once |
| Rate limiting | Sliding-window log in a **Lua script** (atomic across API instances); fails open if Redis is down |
| Partner proximity | `GEOADD` / `GEOSEARCH` (nearest within 15 km); last known location kept for re-indexing |
| Socket.IO scale-out | Redis adapter (rooms shared across API instances) and Redis emitter (workers push to browsers) |

## Delivery assignment
On `order.confirmed` the delivery worker finds candidates via `GEOSEARCH` and **atomically claims** one:
`UPDATE DeliveryPartnerProfile SET isAvailable=false WHERE userId=$id AND isAvailable=true` (1 row affected for exactly one order),
then creates the `Delivery` and an outbox event. No partner free → throw → retry-with-delay. If Redis itself errors, it
degrades to a database candidate list; an *empty* GEO result is meaningful (nobody nearby) and does not fall back.
When a delivery ends or is cancelled the partner is released and re-indexed.

## Real-time
Authenticated at handshake (JWT). Sockets auto-join `user:<id>` (+ `restaurant:<id>` for owners, `admin`). Joining
`order:<id>` requires being a participant (server-verified). Events: `order:status`, `delivery:assigned`, `delivery:location`,
`notification:new`. Consumers run concurrently so events can be delivered out of order; each status event carries a monotonic
`seq` (the outbox id) and the client ignores stale ones and re-fetches the authoritative state.

## Database design
Indexes (all in `migrations/…_init`): unique `(customerId, idempotencyKey)`; `(customerId, placedAt DESC)`;
`(restaurantId, status, placedAt DESC)`; `(restaurantId, isAvailable)`; GIN trigram on restaurant and dish names; partial index
on unpublished outbox rows. `CHECK` constraints: stock ≥ 0, price > 0, cart quantity > 0. `OrderItem.menuItemId` is intentionally
not a foreign key (orders are historical records). Money is stored as integer cents.
Connection pooling: one shared `pg.Pool` (`DB_POOL_MAX`, default 20) under Prisma; pool state is exported as metrics.

## Security
scrypt password hashing (constant-time compare; dummy hash for unknown emails to avoid timing-based user enumeration);
JWT HS256 with algorithm pinned on verify; role checks on every route plus resource-level ownership checks; admins can't self-register;
Helmet; CORS allow-list; 100 kB body limit; Zod validation everywhere; secrets never logged (redaction); stock numbers never exposed publicly.

## Observability
`/metrics` on the API (`:4000`) and worker (`:4001`): HTTP latency histograms by route template, request counters, cache hit/miss,
pool connections, orders, transitions, queue throughput and handler time, outbox backlog and publish lag, WebSocket count, rate-limit
rejections, plus Node defaults (CPU, memory, GC, event-loop lag). Structured JSON logs with a request ID (echoed in `x-request-id`).

## Known limitations (deliberate scope cuts)
* Payments are simulated (no gateway); refunds are state changes only.
* Auth is a single short-lived access token (no refresh tokens / revocation list); disabled users stop being able to log in but an existing token works until expiry.
* Search is substring matching, not ranked full-text search.
* Partner location history isn't stored (only the latest position).
* Horizontal scaling of the API is supported by design (stateless + Redis adapter) but was not load-tested across multiple instances.
* The UI is intentionally simple; no maps.
