import type { OrderStatus } from '@prisma/client';

/** Routing keys: `order.<status>` for every status change (e.g. order.placed, order.confirmed) and `delivery.assigned`. */
export const orderEventType = (s: OrderStatus): string => `order.${s.toLowerCase()}`;
export const DELIVERY_ASSIGNED = 'delivery.assigned';

export interface OrderEventData {
  orderId: string;
  customerId: string;
  restaurantId: string;
  restaurantName: string;
  ownerId: string;
  from: OrderStatus | null;
  to: OrderStatus;
  actorId: string | null;
  totalCents: number;
}

export interface DeliveryAssignedData {
  orderId: string;
  customerId: string;
  restaurantId: string;
  ownerId: string;
  partnerId: string;
}

/** What actually travels through RabbitMQ. eventId is the outbox row id (used for de-duplication). */
export interface EventEnvelope<T = unknown> {
  eventId: string;
  type: string;
  occurredAt: string;
  data: T;
}
