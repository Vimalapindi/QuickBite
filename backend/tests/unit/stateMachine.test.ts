import type { OrderStatus } from '@prisma/client';
import { TRANSITIONS, allowedNext, canTransition, isTerminal } from '../../src/modules/orders/orderStateMachine';

describe('order state machine', () => {
  it('follows the happy path with the right actors', () => {
    expect(canTransition('PLACED', 'PAID', 'SYSTEM')).toBe(true);
    expect(canTransition('PAID', 'CONFIRMED', 'RESTAURANT')).toBe(true);
    expect(canTransition('CONFIRMED', 'PREPARING', 'RESTAURANT')).toBe(true);
    expect(canTransition('PREPARING', 'READY_FOR_PICKUP', 'RESTAURANT')).toBe(true);
    expect(canTransition('READY_FOR_PICKUP', 'PICKED_UP', 'PARTNER')).toBe(true);
    expect(canTransition('PICKED_UP', 'DELIVERED', 'PARTNER')).toBe(true);
  });

  it('rejects skipping states', () => {
    expect(canTransition('PAID', 'DELIVERED', 'PARTNER')).toBe(false);
    expect(canTransition('PLACED', 'PREPARING', 'RESTAURANT')).toBe(false);
  });

  it('rejects the wrong actor', () => {
    expect(canTransition('PAID', 'CONFIRMED', 'CUSTOMER')).toBe(false);
    expect(canTransition('PLACED', 'PAID', 'CUSTOMER')).toBe(false); // customers can't mark themselves paid
    expect(canTransition('READY_FOR_PICKUP', 'PICKED_UP', 'RESTAURANT')).toBe(false);
  });

  it('lets customers cancel only before the restaurant confirms', () => {
    expect(canTransition('PLACED', 'CANCELLED', 'CUSTOMER')).toBe(true);
    expect(canTransition('PAID', 'CANCELLED', 'CUSTOMER')).toBe(true);
    expect(canTransition('CONFIRMED', 'CANCELLED', 'CUSTOMER')).toBe(false);
    expect(canTransition('CONFIRMED', 'CANCELLED', 'ADMIN')).toBe(true);
  });

  it('has no way out of terminal states', () => {
    const terminal: OrderStatus[] = ['DELIVERED', 'CANCELLED', 'REJECTED', 'PAYMENT_FAILED'];
    for (const s of terminal) {
      expect(isTerminal(s)).toBe(true);
      expect(allowedNext(s, 'ADMIN')).toEqual([]);
    }
  });

  it('only references real statuses and exposes allowedNext per actor', () => {
    const all = Object.keys(TRANSITIONS);
    for (const from of all) for (const to of Object.keys(TRANSITIONS[from as OrderStatus])) expect(all).toContain(to);
    expect(allowedNext('PAID', 'RESTAURANT').sort()).toEqual(['CONFIRMED', 'REJECTED']);
  });
});
