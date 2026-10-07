# Resume bullets and viva / interview preparation

## Resume rules
1. **Only quote numbers you measured yourself** on your own machine with `loadtest/` (see LOADTEST.md section 4). Keep the raw k6 output.
2. Say what the hardware was ("on a 4-core laptop") when you quote throughput.
3. Be ready to open the repo and show the code behind every claim. Every bullet below maps to a real file.

## Project line
**QuickBite: real-time food delivery platform** · Node.js, TypeScript, Express, PostgreSQL, Prisma, Redis, RabbitMQ, Socket.IO, React, Docker, k6, Prometheus/Grafana · [GitHub link]

## Bullets (fill the brackets from YOUR results)
Pick 4–6. These are templates: delete any you didn't verify.

* Designed a **modular-monolith** food delivery backend (Node.js/TypeScript/Express, PostgreSQL) with role-based access for four user types, an explicit **order state machine**, and a React + Socket.IO client with live order tracking.
* Built **idempotent, transactional order placement**: atomic stock decrement via conditional `UPDATE`, price snapshots and outbox write in one PostgreSQL transaction; verified with tests where 50 concurrent customers competed for 10 portions (exactly 10 succeeded, 0 oversold) and 15 simultaneous duplicate requests produced one order.
* Implemented the **transactional outbox pattern** with RabbitMQ (publisher confirms, retry-with-delay queues, dead-letter queue) and idempotent consumers for payment simulation, partner assignment and notifications, achieving at-least-once processing without lost or duplicated side effects.
* Added **Redis cache-aside** (TTL + jitter, single-flight stampede protection, version-counter invalidation), reaching a **[X]% cache hit ratio** and cutting p95 read latency from **[A] ms to [B] ms** in k6 tests on [hardware].
* Optimized queries with composite, partial and **trigram GIN indexes**; verified with `EXPLAIN ANALYZE` (dish search [A] ms → [B] ms on a 500k-row table).
* Built a **Redis Lua sliding-window rate limiter** (atomic across instances) and **GEO-based nearest-partner assignment** with an atomic claim that prevents double assignment.
* Instrumented the API and workers with **Prometheus/Grafana** (RED metrics, cache hit ratio, DB pool, queue lag, event-loop lag, CPU/memory); load-tested with **k6** to **[N] req/s at p95 < [X] ms and [Y]% errors** on [hardware].
* Wrote **93 automated tests** (Jest/Supertest against real PostgreSQL, Redis and RabbitMQ, plus a Playwright browser journey), Dockerized the stack (Compose, multi-stage builds) and added CI.

## What to say in 60 seconds
"QuickBite is a food delivery platform. The interesting part is the backend: placing an order is one database transaction that
atomically reserves stock, writes the order, and records an event in an outbox table. A worker publishes outbox events to
RabbitMQ; separate consumers simulate payment, assign the nearest delivery partner using Redis GEO, and send notifications, and
Socket.IO pushes every status change to the customer live. Everything that can be retried is idempotent, because the broker
delivers at-least-once. I tested concurrency directly (50 people racing for 10 portions) and load-tested with k6."

## Questions you should expect (with answers grounded in this code)

**Architecture**
1. *Why a modular monolith, not microservices?* One team, one deployable, strong consistency in the order transaction. Modules are isolated enough to extract later. Microservices would add distributed transactions with no benefit at this size.
2. *Why a separate worker process?* Slow/failure-prone work (payment, notifications) must not add API latency or be lost when a request dies. It also scales independently.
3. *Why is the cart in PostgreSQL, not Redis?* Converting cart → order must be atomic with the stock change; the cart is durable user data. Redis is never authoritative here.

**Consistency and concurrency**
4. *How do you prevent overselling?* `UPDATE ... SET stock = stock - q WHERE id = ? AND stock >= q`. Postgres row-locks, so concurrent updates serialise; the loser affects 0 rows and the transaction rolls back. A `CHECK (stock >= 0)` backs it up. (`orders.service.ts`, test: 50 vs 10.)
5. *Why not `SELECT ... FOR UPDATE` or `SERIALIZABLE`?* The conditional update is one statement, holds the lock briefly and needs no retry loop. Locks are taken in sorted item order to avoid deadlocks between multi-item orders.
6. *How is idempotency implemented?* `Idempotency-Key` header + unique index `(customerId, key)`. A replay returns the original order; a simultaneous duplicate hits the unique violation and returns the winner's order. The frontend generates one key per checkout attempt.
7. *Two actors change an order at once (customer cancels, restaurant confirms)?* Optimistic concurrency: `UPDATE ... WHERE id AND status = <what I read>`; exactly one wins, the other gets `409`. Tested.
8. *Why store price snapshots?* Menu edits must not rewrite history or totals.

**Messaging**
9. *What problem does the outbox solve?* Dual write: you can't atomically commit to Postgres and publish to RabbitMQ. Write the event in the same transaction; relay it afterwards.
10. *Can messages be duplicated? Lost?* Not lost (outbox + publisher confirms + durable persistent messages). Duplicates are possible (crash after publish before marking), so consumers are idempotent: payment's conditional update, notification unique `(userId, eventId)`, assignment skip-if-assigned.
11. *What happens when a consumer fails?* Republished to a TTL retry queue that dead-letters back to the work queue; after N attempts it goes to the DLQ. Poison (unparseable) messages go straight to the DLQ.
12. *Ordering?* Not guaranteed with concurrent consumers. Status events carry a monotonic `seq`; clients drop stale ones and re-fetch state.
13. *What if RabbitMQ is down?* The API keeps working; events accumulate in the outbox (visible as the backlog metric) and flow when the broker returns.

**Redis**
14. *Cache invalidation strategy?* Short TTL as a safety net; delete the detail key on writes; list/search keys embed a version counter that is incremented, so all old pages become unreachable at once.
15. *What's a cache stampede and how do you avoid it?* Many concurrent misses hit the DB when a hot key expires. In-process single-flight shares one load; TTL jitter spreads expirations. (Test: 25 concurrent requests → ≤ 2 DB loads.)
16. *Why a Lua script for rate limiting?* Trim + count + add must be atomic across API instances; Lua runs atomically in Redis. Sliding window avoids the fixed-window boundary burst. It fails open if Redis is down.
17. *What if Redis dies?* Cache reads fall through to Postgres, rate limiting is skipped, partner search degrades to a DB query. (`enableOfflineQueue: false` so commands fail fast instead of hanging.)

**Database**
18. *Which indexes and why?* `(restaurantId, status, placedAt DESC)` serves the restaurant order list with no sort; GIN trigram makes `ILIKE '%x%'` indexable; partial index on unpublished outbox rows stays tiny. `EXPLAIN ANALYZE` evidence in LOADTEST.md.
19. *Connection pooling?* One shared `pg.Pool` (max 20) under Prisma. Postgres spawns a process per connection, so the pool caps it; excess requests queue in Node. `db_pool_connections{state="waiting"}` shows when the pool is the bottleneck.
20. *Why is money in integer cents?* Floating point can't represent decimals exactly.

**Security and ops**
21. *How do you store passwords?* scrypt with a per-user salt, constant-time comparison; unknown emails are verified against a dummy hash to avoid timing leaks.
22. *JWT downsides?* Stateless, so no instant revocation. Mitigated by a short expiry; production would add refresh tokens and a deny-list.
23. *Liveness vs readiness?* Liveness = process is up (restart if not). Readiness = dependencies reachable (stop routing traffic, don't restart). A DB blip shouldn't cause restart loops.
24. *Graceful shutdown?* On SIGTERM stop accepting connections, finish in-flight requests, close sockets, DB, Redis, then exit (with a 15 s force timeout).
25. *How would you scale it?* API is stateless (JWT) and Socket.IO uses the Redis adapter, so run N instances behind a load balancer; relay uses `SKIP LOCKED` so N relays are safe; workers scale by adding consumers. Next bottleneck: Postgres (read replicas, partitioning orders).

**Honest-limitations questions (answer confidently)**
26. *Is the payment real?* No: a simulated gateway behind the same asynchronous flow; swapping in a real provider means implementing `processPayment` and webhooks.
27. *What would you do next?* Refresh tokens, ranked full-text search, location history, multi-instance load test, per-restaurant menus caching with CDN, OpenTelemetry tracing.
28. *Any bugs you found while building?* Yes, and the tests caught them: (a) a partner who finished a delivery was never re-added to the Redis GEO index, so they were never assigned again; (b) the delivery search wrongly fell back to a distance-blind DB query when no partner was nearby; (c) status events could arrive out of order, which led to the `seq` guard. Good stories to tell.
