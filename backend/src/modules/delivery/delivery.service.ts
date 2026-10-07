import { env } from '../../config/env';
import { redis } from '../../infra/cache/redis';
import { prisma } from '../../infra/db/prisma';
import { enqueueEvent } from '../../infra/queue/outbox';
import { AppError } from '../../shared/errors/AppError';
import { DELIVERY_ASSIGNED, type DeliveryAssignedData } from '../../shared/events';
import { emitToRooms } from '../../infra/realtime/emitter';
import { orderRoom } from '../../infra/realtime/rooms';

const GEO_KEY = 'geo:partners';
const activeOrderKey = (partnerId: string) => `partner:${partnerId}:active_order`;
const lastLocKey = (partnerId: string) => `partner:${partnerId}:loc`;

/**
 * Puts a partner (back) into the GEO index using their last known position (Redis first, DB fallback).
 * Called when they go available AND when a delivery finishes/is cancelled: assignment removes them from the
 * index so they can't be picked twice, so releasing them must re-add them.
 */
export async function reindexPartner(partnerId: string): Promise<void> {
  try {
    let lat: number | undefined, lng: number | undefined;
    const raw = await redis.get(lastLocKey(partnerId));
    if (raw) [lat, lng] = raw.split(',').map(Number);
    else {
      const p = await prisma.deliveryPartnerProfile.findUnique({ where: { userId: partnerId } });
      if (p?.currentLat != null && p.currentLng != null) { lat = p.currentLat; lng = p.currentLng; }
    }
    if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng)) await redis.geoadd(GEO_KEY, lng, lat, partnerId);
  } catch { /* Redis down: the DB-fallback candidate search still finds available partners */ }
}

export class NoPartnerAvailable extends Error {
  constructor() { super('no delivery partner available'); }
}

export async function setAvailability(partnerId: string, isAvailable: boolean) {
  if (isAvailable) {
    // A partner on an active delivery must not become assignable again (would allow double assignment).
    const active = await prisma.delivery.count({ where: { partnerId, status: { in: ['ASSIGNED', 'PICKED_UP'] } } });
    if (active > 0) throw AppError.conflict('Finish your active delivery before going available', 'ACTIVE_DELIVERY');
  }
  const profile = await prisma.deliveryPartnerProfile.update({ where: { userId: partnerId }, data: { isAvailable } });
  if (!isAvailable) await redis.zrem(GEO_KEY, partnerId).catch(() => undefined);
  else await reindexPartner(partnerId);
  return profile;
}

/**
 * Location pings arrive often, so the hot path is Redis only (GEOADD). The database copy is refreshed at most
 * every 15 seconds (SET NX EX throttle) so a stream of pings doesn't become a stream of DB writes.
 */
export async function updateLocation(partnerId: string, lat: number, lng: number) {
  const profile = await prisma.deliveryPartnerProfile.findUnique({ where: { userId: partnerId }, select: { isAvailable: true } });
  if (!profile) throw AppError.notFound('Delivery profile not found');

  const activeOrderId = await redis.get(activeOrderKey(partnerId)).catch(() => null);
  await redis.set(lastLocKey(partnerId), `${lat},${lng}`, 'EX', 24 * 3600).catch(() => undefined);
  if (profile.isAvailable) await redis.geoadd(GEO_KEY, lng, lat, partnerId);

  const first = await redis.set(`partner:${partnerId}:dbwrite`, '1', 'EX', 15, 'NX').catch(() => 'OK');
  if (first === 'OK') {
    await prisma.deliveryPartnerProfile.update({
      where: { userId: partnerId },
      data: { currentLat: lat, currentLng: lng, locationUpdatedAt: new Date() },
    });
  }
  if (activeOrderId) {
    await emitToRooms([orderRoom(activeOrderId)], 'delivery:location', { orderId: activeOrderId, partnerId, lat, lng, at: new Date().toISOString() });
  }
  return { activeOrderId };
}

export async function myDeliveries(partnerId: string, scope: 'active' | 'completed') {
  const profile = await prisma.deliveryPartnerProfile.findUnique({ where: { userId: partnerId } });
  if (!profile) throw AppError.notFound('Delivery profile not found');
  const deliveries = await prisma.delivery.findMany({
    where: { partnerId, status: scope === 'active' ? { in: ['ASSIGNED', 'PICKED_UP'] } : 'DELIVERED' },
    orderBy: { assignedAt: 'desc' },
    take: 50,
    include: {
      order: {
        select: {
          id: true, status: true, totalCents: true,
          restaurant: { select: { id: true, name: true, address: true, lat: true, lng: true } },
          address: { select: { line1: true, city: true, lat: true, lng: true } },
        },
      },
    },
  });
  return { profile, deliveries };
}

async function findCandidates(lat: number, lng: number): Promise<string[]> {
  try {
    // GEOSEARCH: nearest available partners within 15 km of the restaurant, closest first.
    // An EMPTY result is meaningful ("nobody nearby") and must NOT fall through to a distance-blind query.
    return (await redis.call('GEOSEARCH', GEO_KEY, 'FROMLONLAT', lng, lat, 'BYRADIUS', 15, 'km', 'ASC', 'COUNT', 10)) as string[];
  } catch {
    // Degraded mode: ONLY when Redis itself is failing, fall back to the (distance-blind) database list.
    const rows = await prisma.deliveryPartnerProfile.findMany({
      where: { isAvailable: true }, orderBy: { updatedAt: 'asc' }, take: 10, select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }
}

/**
 * Assign the nearest free partner to an order. Safe under concurrency:
 * the claim `UPDATE ... SET isAvailable=false WHERE isAvailable=true` affects 1 row for exactly ONE order,
 * so two orders being assigned at the same time can never get the same partner.
 * Throws NoPartnerAvailable so the queue consumer retries later (retry-with-delay).
 */
export async function assignPartner(orderId: string): Promise<'assigned' | 'skipped'> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { restaurant: true, delivery: true },
  });
  if (!order || order.delivery) return 'skipped';
  if (!['CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status)) return 'skipped';

  const candidates = await findCandidates(order.restaurant.lat, order.restaurant.lng);
  for (const partnerId of candidates) {
    const assigned = await prisma.$transaction(async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "DeliveryPartnerProfile" SET "isAvailable" = false, "updatedAt" = now()
        WHERE "userId" = ${partnerId}::uuid AND "isAvailable" = true`;
      if (claimed === 0) return false;
      await tx.delivery.create({ data: { orderId, partnerId } });
      const data: DeliveryAssignedData = {
        orderId, customerId: order.customerId, restaurantId: order.restaurantId, ownerId: order.restaurant.ownerId, partnerId,
      };
      await enqueueEvent(tx, { aggregateType: 'order', aggregateId: orderId, type: DELIVERY_ASSIGNED, data });
      return true;
    });
    if (assigned) {
      await redis.zrem(GEO_KEY, partnerId).catch(() => undefined);
      await redis.set(activeOrderKey(partnerId), orderId, 'EX', 6 * 3600).catch(() => undefined);
      return 'assigned';
    }
  }
  throw new NoPartnerAvailable();
}

export const deliveryConfig = { retryDelayMs: env.DELIVERY_RETRY_DELAY_MS, maxAttempts: env.DELIVERY_MAX_ATTEMPTS };
