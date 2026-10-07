import type { OrderStatus } from '@prisma/client';

/** Who is performing a transition. SYSTEM = background workers (payment). */
export type Actor = 'CUSTOMER' | 'RESTAURANT' | 'PARTNER' | 'ADMIN' | 'SYSTEM';

/**
 * The order lifecycle as an explicit state machine: from -> to -> which actors may do it.
 * Anything not listed is rejected, so e.g. DELIVERED -> PREPARING is impossible by construction.
 *
 *  PLACED -> PAID -> CONFIRMED -> PREPARING -> READY_FOR_PICKUP -> PICKED_UP -> DELIVERED
 *     \-> PAYMENT_FAILED     \-> REJECTED (restaurant)         (CANCELLED: customer early, admin later)
 */
export const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderStatus, Actor[]>>> = {
  PLACED: { PAID: ['SYSTEM'], PAYMENT_FAILED: ['SYSTEM'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  PAID: { CONFIRMED: ['RESTAURANT'], REJECTED: ['RESTAURANT'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  CONFIRMED: { PREPARING: ['RESTAURANT'], CANCELLED: ['ADMIN'] },
  PREPARING: { READY_FOR_PICKUP: ['RESTAURANT'], CANCELLED: ['ADMIN'] },
  READY_FOR_PICKUP: { PICKED_UP: ['PARTNER'], CANCELLED: ['ADMIN'] },
  PICKED_UP: { DELIVERED: ['PARTNER'] },
  DELIVERED: {},
  CANCELLED: {},
  REJECTED: {},
  PAYMENT_FAILED: {},
};

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  return TRANSITIONS[from][to]?.includes(actor) ?? false;
}

export function allowedNext(from: OrderStatus, actor: Actor): OrderStatus[] {
  return (Object.entries(TRANSITIONS[from]) as [OrderStatus, Actor[]][])
    .filter(([, actors]) => actors.includes(actor))
    .map(([to]) => to);
}

export function isTerminal(s: OrderStatus): boolean {
  return Object.keys(TRANSITIONS[s]).length === 0;
}

/** Statuses that give inventory back and (if it was paid) trigger a refund. */
export const RELEASES_STOCK: OrderStatus[] = ['CANCELLED', 'REJECTED', 'PAYMENT_FAILED'];
