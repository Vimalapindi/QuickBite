# API reference

Base URL `http://localhost:4000/api` (or `http://localhost:8080/api` through nginx). JSON in, JSON out.
Authenticated routes need `Authorization: Bearer <token>` (from `/auth/login` or `/auth/register`).

**Error shape (every error):** `{ "error": { "code": "OUT_OF_STOCK", "message": "...", "details"?: ... } }`

| Status | Meaning |
|---|---|
| 400 | `VALIDATION_ERROR` (with per-field `details`), `INVALID_JSON`, `CART_EMPTY`, `ADDRESS_NOT_FOUND`, `BAD_REQUEST` |
| 401 | `UNAUTHORIZED`, `INVALID_CREDENTIALS` |
| 403 | `FORBIDDEN` (wrong role / not your resource), `ACCOUNT_DISABLED` |
| 404 | `NOT_FOUND` |
| 409 | `EMAIL_TAKEN`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, `ITEM_UNAVAILABLE`, `RESTAURANT_CLOSED`, `CART_RESTAURANT_MISMATCH`, `INVALID_TRANSITION`, `ORDER_CHANGED`, `ACTIVE_DELIVERY` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 429 | `RATE_LIMITED` (headers: `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`) |
| 500 | `INTERNAL_ERROR` (details only in server logs) |

Operational (no auth, not rate limited, not under `/api`): `GET /health/live`, `GET /health/ready`, `GET /metrics`.

## Auth: `/api/auth`
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/register` | public | `{ email, password(≥8), name, phone?, role: CUSTOMER\|RESTAURANT_OWNER\|DELIVERY_PARTNER, vehicleType? }`; `ADMIN` is rejected |
| POST | `/login` | public | `{ email, password }` → `{ user, token }` |
| GET | `/me` | any | current user |

## Users: `/api/users`
| GET | `/me/addresses` | any | |
| POST | `/me/addresses` | any | `{ label?, line1, city, pincode, lat, lng }` |

## Restaurants and menu: `/api/restaurants`, `/api/menu-items`, `/api/search`
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/restaurants` | public (cached) | `?city=&cuisine=&q=&page=&limit=(≤50)` → `{ data, meta }` |
| GET | `/restaurants/:id` | public (cached) | restaurant + categories + items (`soldOut` flag; exact stock is private) |
| GET | `/restaurants/mine` | owner/admin | |
| POST | `/restaurants` | owner/admin | creates a restaurant owned by the caller |
| PATCH | `/restaurants/:id` | owner of it / admin | incl. `isOpen` |
| GET | `/restaurants/:id/menu/manage` | owner/admin | includes exact `stock`; never cached |
| POST | `/restaurants/:id/categories` | owner/admin | `{ name, sortOrder? }` |
| POST | `/restaurants/:id/items` | owner/admin | `{ name, priceCents, categoryId?, stock? (null = unlimited), isAvailable?, description? }` |
| PATCH / DELETE | `/menu-items/:id` | owner of it / admin | |
| GET | `/search?q=(≥2 chars)&city=` | public (cached) | `{ restaurants, items }` |

## Cart: `/api/cart` (customers)
| GET | `/` | cart with totals |
| PUT | `/items` | `{ menuItemId, quantity (0 removes), replaceCart? }`. Switching restaurant returns `409 CART_RESTAURANT_MISMATCH` unless `replaceCart: true` |
| DELETE | `/items/:menuItemId`, `/` | remove one line / clear |

## Orders: `/api/orders`
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/` | customer | **Requires `Idempotency-Key` header** (8–128 chars). Body `{ addressId, paymentSimulation?: SUCCESS\|FAIL }`. `201` new order; `200` + `Idempotent-Replayed: true` when the key was already used |
| GET | `/` | customer | `?status=&page=&limit=` |
| GET | `/restaurant/:id` | owner of it / admin | restaurant order management; each row includes `nextStatuses` |
| GET | `/:id` | participant / admin | order + `viewerRole` + `nextStatuses` (what *you* may do now) |
| GET | `/:id/tracking` | participant / admin | status history, destination, partner info |
| POST | `/:id/status` | participant / admin | `{ status, note? }`, validated by the state machine |

## Delivery: `/api/delivery` (partners)
| GET | `/me?scope=active\|completed` | profile + deliveries |
| PATCH | `/me/availability` | `{ isAvailable }` (409 while on an active delivery) |
| PUT | `/me/location` | `{ lat, lng }`: Redis GEO + live push to the order room |

## Notifications: `/api/notifications` (any user)
| GET | `/` | `?page=&limit=` → `{ data, unreadCount, meta }` |
| POST | `/read-all`, `/:id/read` | |

## Admin: `/api/admin`
| GET | `/stats` | cached 10 s |
| GET | `/users?role=`, `/orders?status=` | paginated |
| PATCH | `/users/:id/active` | `{ isActive }` (admins can't be disabled) |

## Socket.IO
Connect with `io(url, { auth: { token } })`. Server → client events:
`ready`, `order:status { orderId, from, status, seq, at }`, `delivery:assigned { orderId, partnerId, seq }`,
`delivery:location { orderId, partnerId, lat, lng, at }`, `notification:new { ...notification }`.
Client → server: `order:subscribe(orderId, ack)` (participants only), `order:unsubscribe(orderId)`.
Always ignore events with a `seq` lower than the last you applied; delivery order isn't guaranteed.
