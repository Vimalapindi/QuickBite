import { Prisma, type OrderStatus } from '@prisma/client';
import { redis } from '../../infra/cache/redis';
import { reindexPartner } from '../delivery/delivery.service';
import { prisma, type Tx } from '../../infra/db/prisma';
import { orderTransitions, ordersCreated } from '../../infra/metrics/metrics';
import { enqueueEvent } from '../../infra/queue/outbox';
import { AppError } from '../../shared/errors/AppError';
import { type OrderEventData, orderEventType } from '../../shared/events';
import type { AuthUser } from '../../shared/utils/jwt';
import { pageMeta } from '../../shared/utils/pagination';
import { isUniqueViolation } from '../../shared/utils/prismaErrors';
import { type Actor, RELEASES_STOCK, allowedNext, canTransition } from './orderStateMachine';

const orderInclude = {
  items: true,
  payment: { select: { status: true, amountCents: true, failureReason: true } },
  restaurant: { select: { id: true, name: true } },
  delivery: { select: { partnerId: true, status: true } },
} satisfies Prisma.OrderInclude;

type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export function serializeOrder(o: OrderWithRelations) {
  return {
    id: o.id,
    status: o.status,
    restaurant: o.restaurant,
    customerId: o.customerId,
    addressId: o.addressId,
    subtotalCents: o.subtotalCents,
    deliveryFeeCents: o.deliveryFeeCents,
    totalCents: o.totalCents,
    placedAt: o.placedAt,
    updatedAt: o.updatedAt,
    items: o.items.map((i) => ({ menuItemId: i.menuItemId, name: i.nameSnapshot, priceCents: i.priceCentsSnapshot, quantity: i.quantity })),
    payment: o.payment,
    delivery: o.delivery,
  };
}

const findByKey = (customerId: string, idempotencyKey: string) =>
  prisma.order.findUnique({ where: { customerId_idempotencyKey: { customerId, idempotencyKey } }, include: orderInclude });

export interface CreateOrderInput {
  addressId: string;
  paymentSimulation: 'SUCCESS' | 'FAIL';
}

/**
 * Places an order. Everything below happens in ONE PostgreSQL transaction (all-or-nothing):
 *   1. validate cart/address/restaurant
 *   2. atomically decrement stock with a conditional UPDATE (no overselling, no explicit lock)
 *   3. insert order + items (price snapshots) + status history + payment + outbox event
 *   4. empty the cart
 * Idempotency: (customerId, idempotencyKey) is UNIQUE. A retry/double-click replays the original order.
 */
export async function createOrder(customerId: string, input: CreateOrderInput, idempotencyKey: string) {
  const existing = await findByKey(customerId, idempotencyKey);
  if (existing) {
    ordersCreated.inc({ outcome: 'replayed' });
    return { order: serializeOrder(existing), replayed: true };
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      const address = await tx.address.findFirst({ where: { id: input.addressId, userId: customerId } });
      if (!address) throw new AppError(400, 'ADDRESS_NOT_FOUND', 'Address not found');

      const cart = await tx.cart.findUnique({ where: { userId: customerId }, include: { items: { include: { menuItem: true } } } });
      if (!cart || cart.items.length === 0 || !cart.restaurantId) throw new AppError(400, 'CART_EMPTY', 'Your cart is empty');

      const restaurant = await tx.restaurant.findUnique({ where: { id: cart.restaurantId } });
      if (!restaurant) throw AppError.notFound('Restaurant not found');
      if (!restaurant.isOpen) throw AppError.conflict('This restaurant is currently closed', 'RESTAURANT_CLOSED');

      // Lock ordering: always touch rows in the same order so two concurrent orders can't deadlock each other.
      const lines = [...cart.items].sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));
      for (const line of lines) {
        if (!line.menuItem.isAvailable) {
          throw AppError.conflict(`"${line.menuItem.name}" is no longer available`, 'ITEM_UNAVAILABLE');
        }
        if (line.menuItem.stock !== null) {
          // Atomic check-and-decrement. Under concurrency the row lock serialises these UPDATEs; once stock
          // hits 0 the WHERE no longer matches, so the loser gets 0 rows affected instead of a negative stock.
          const updated = await tx.$executeRaw`
            UPDATE "MenuItem" SET "stock" = "stock" - ${line.quantity}, "updatedAt" = now()
            WHERE "id" = ${line.menuItemId}::uuid AND "stock" >= ${line.quantity}`;
          if (updated === 0) {
            ordersCreated.inc({ outcome: 'out_of_stock' });
            throw AppError.conflict(`"${line.menuItem.name}" is out of stock`, 'OUT_OF_STOCK');
          }
        }
      }

      const subtotalCents = lines.reduce((s, l) => s + l.menuItem.priceCents * l.quantity, 0);
      const deliveryFeeCents = restaurant.deliveryFeeCents;
      const totalCents = subtotalCents + deliveryFeeCents;

      const created = await tx.order.create({
        data: {
          customerId,
          restaurantId: restaurant.id,
          addressId: address.id,
          subtotalCents,
          deliveryFeeCents,
          totalCents,
          idempotencyKey,
          items: {
            create: lines.map((l) => ({
              menuItemId: l.menuItemId,
              nameSnapshot: l.menuItem.name,
              priceCentsSnapshot: l.menuItem.priceCents,
              quantity: l.quantity,
            })),
          },
          history: { create: { fromStatus: null, toStatus: 'PLACED', changedById: customerId } },
          payment: { create: { amountCents: totalCents, simulateOutcome: input.paymentSimulation } },
        },
        include: orderInclude,
      });

      const data: OrderEventData = {
        orderId: created.id, customerId, restaurantId: restaurant.id, restaurantName: restaurant.name,
        ownerId: restaurant.ownerId, from: null, to: 'PLACED', actorId: customerId, totalCents,
      };
      await enqueueEvent(tx, { aggregateType: 'order', aggregateId: created.id, type: orderEventType('PLACED'), data });

      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { restaurantId: null } });
      return created;
    });
    ordersCreated.inc({ outcome: 'created' });
    return { order: serializeOrder(order), replayed: false };
  } catch (e) {
    // A concurrent request with the same key won the race (unique violation), or already emptied the cart.
    const raced = isUniqueViolation(e) || (e instanceof AppError && e.code === 'CART_EMPTY');
    if (raced) {
      const winner = await findByKey(customerId, idempotencyKey);
      if (winner) {
        ordersCreated.inc({ outcome: 'replayed' });
        return { order: serializeOrder(winner), replayed: true };
      }
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------------------------

export type AfterCommit = () => Promise<void>;

export interface TransitionActor {
  type: Actor;
  userId: string | null;
}

/**
 * Applies one validated transition inside the caller's transaction. Used by both the HTTP API and the
 * payment worker (which wraps it together with its own payment update so they commit atomically).
 * Returns callbacks to run AFTER the transaction commits (Redis housekeeping must not run on a rolled-back tx).
 */
export async function applyTransition(
  tx: Tx,
  orderId: string,
  to: OrderStatus,
  actor: TransitionActor,
  note?: string,
): Promise<{ afterCommit: AfterCommit[] }> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { restaurant: { select: { name: true, ownerId: true } }, delivery: true },
  });
  if (!order) throw AppError.notFound('Order not found');

  if (!canTransition(order.status, to, actor.type)) {
    throw AppError.conflict(`Cannot move order from ${order.status} to ${to}`, 'INVALID_TRANSITION', {
      from: order.status, to, allowed: allowedNext(order.status, actor.type),
    });
  }

  // Optimistic concurrency: only update if the status is still what we read. If two actors race
  // (customer cancels while restaurant confirms), exactly one wins and the other gets a 409.
  const { count } = await tx.order.updateMany({ where: { id: orderId, status: order.status }, data: { status: to } });
  if (count === 0) throw AppError.conflict('Order was modified concurrently, please retry', 'ORDER_CHANGED');

  await tx.orderStatusHistory.create({
    data: { orderId, fromStatus: order.status, toStatus: to, changedById: actor.userId, note },
  });

  const afterCommit: AfterCommit[] = [];

  if (RELEASES_STOCK.includes(to)) {
    // Compensation: give reserved inventory back (only for items that track stock).
    const items = await tx.orderItem.findMany({ where: { orderId } });
    for (const it of [...items].sort((a, b) => a.menuItemId.localeCompare(b.menuItemId))) {
      await tx.$executeRaw`UPDATE "MenuItem" SET "stock" = "stock" + ${it.quantity}, "updatedAt" = now()
        WHERE "id" = ${it.menuItemId}::uuid AND "stock" IS NOT NULL`;
    }
    if (order.status !== 'PLACED') {
      await tx.payment.updateMany({ where: { orderId, status: 'SUCCEEDED' }, data: { status: 'REFUNDED' } });
    }
    if (order.delivery && order.delivery.status !== 'DELIVERED') {
      await tx.delivery.delete({ where: { id: order.delivery.id } });
      await tx.deliveryPartnerProfile.update({ where: { userId: order.delivery.partnerId }, data: { isAvailable: true } });
      const partnerId = order.delivery.partnerId;
      afterCommit.push(async () => { await redis.del(`partner:${partnerId}:active_order`).catch(() => undefined); await reindexPartner(partnerId); });
    }
  }

  if (to === 'PICKED_UP' && order.delivery) {
    await tx.delivery.update({ where: { id: order.delivery.id }, data: { status: 'PICKED_UP', pickedUpAt: new Date() } });
  }
  if (to === 'DELIVERED' && order.delivery) {
    await tx.delivery.update({ where: { id: order.delivery.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await tx.deliveryPartnerProfile.update({ where: { userId: order.delivery.partnerId }, data: { isAvailable: true } });
    const partnerId = order.delivery.partnerId;
    afterCommit.push(async () => { await redis.del(`partner:${partnerId}:active_order`).catch(() => undefined); await reindexPartner(partnerId); });
  }

  const data: OrderEventData = {
    orderId, customerId: order.customerId, restaurantId: order.restaurantId, restaurantName: order.restaurant.name,
    ownerId: order.restaurant.ownerId, from: order.status, to, actorId: actor.userId, totalCents: order.totalCents,
  };
  await enqueueEvent(tx, { aggregateType: 'order', aggregateId: orderId, type: orderEventType(to), data });

  orderTransitions.inc({ to });
  return { afterCommit };
}

/** Works out which role the requesting user plays for THIS order (a restaurant owner only for their own restaurant, etc.). */
async function resolveActor(user: AuthUser, orderId: string): Promise<Actor> {
  if (user.role === 'ADMIN') return 'ADMIN';
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { customerId: true, restaurant: { select: { ownerId: true } }, delivery: { select: { partnerId: true } } },
  });
  if (!order) throw AppError.notFound('Order not found');
  if (user.id === order.customerId) return 'CUSTOMER';
  if (user.id === order.restaurant.ownerId) return 'RESTAURANT';
  if (user.id === order.delivery?.partnerId) return 'PARTNER';
  throw AppError.forbidden('You are not a participant in this order');
}

export async function changeStatus(user: AuthUser, orderId: string, to: OrderStatus, note?: string) {
  const actor = await resolveActor(user, orderId);
  const { afterCommit } = await prisma.$transaction((tx) => applyTransition(tx, orderId, to, { type: actor, userId: user.id }, note));
  await Promise.all(afterCommit.map((f) => f()));
  return getOrderFor(user, orderId);
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function getOrderFor(user: AuthUser, orderId: string) {
  const actor = await resolveActor(user, orderId);
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) throw AppError.notFound('Order not found');
  return { order: serializeOrder(order), viewerRole: actor, nextStatuses: allowedNext(order.status, actor) };
}

export async function listMyOrders(customerId: string, page: number, limit: number, status?: OrderStatus) {
  const where: Prisma.OrderWhereInput = { customerId, ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([
    prisma.order.findMany({ where, include: orderInclude, orderBy: { placedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.order.count({ where }),
  ]);
  return { data: rows.map(serializeOrder), meta: pageMeta(page, limit, total) };
}

export async function listRestaurantOrders(user: AuthUser, restaurantId: string, page: number, limit: number, status?: OrderStatus) {
  const r = await prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { ownerId: true } });
  if (!r) throw AppError.notFound('Restaurant not found');
  if (user.role !== 'ADMIN' && r.ownerId !== user.id) throw AppError.forbidden('You do not own this restaurant');
  const where: Prisma.OrderWhereInput = { restaurantId, ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([
    prisma.order.findMany({ where, include: orderInclude, orderBy: { placedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.order.count({ where }),
  ]);
  return {
    data: rows.map((o) => ({ ...serializeOrder(o), nextStatuses: allowedNext(o.status, 'RESTAURANT') })),
    meta: pageMeta(page, limit, total),
  };
}

export async function getTracking(user: AuthUser, orderId: string) {
  await resolveActor(user, orderId);
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      history: { orderBy: { createdAt: 'asc' } },
      delivery: { include: { partner: { include: { user: { select: { name: true, phone: true } } } } } },
      address: { select: { lat: true, lng: true, line1: true } },
    },
  });
  if (!order) throw AppError.notFound('Order not found');
  const d = order.delivery;
  return {
    orderId: order.id,
    status: order.status,
    history: order.history.map((h) => ({ from: h.fromStatus, to: h.toStatus, at: h.createdAt, note: h.note })),
    destination: order.address,
    delivery: d
      ? {
          status: d.status,
          partner: { id: d.partnerId, name: d.partner.user.name, phone: d.partner.user.phone, lat: d.partner.currentLat, lng: d.partner.currentLng },
        }
      : null,
  };
}
