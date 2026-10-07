import { planNotifications } from '../../src/workers/notificationRules';
import type { EventEnvelope, OrderEventData } from '../../src/shared/events';

const data = (to: OrderEventData['to']): EventEnvelope<OrderEventData> => ({
  eventId: '1', type: `order.${to.toLowerCase()}`, occurredAt: new Date().toISOString(),
  data: { orderId: 'abcdef12-0000-0000-0000-000000000000', customerId: 'cust', restaurantId: 'rest', restaurantName: 'Spice', ownerId: 'own', from: null, to, actorId: null, totalCents: 100 },
});

describe('planNotifications', () => {
  it('tells the restaurant owner when an order is paid', () => {
    const n = planNotifications(data('PAID'));
    expect(n.map((x) => x.userId).sort()).toEqual(['cust', 'own']);
    expect(n.find((x) => x.userId === 'own')?.type).toBe('NEW_ORDER');
  });
  it('notifies the three parties on delivery assignment', () => {
    const n = planNotifications({ eventId: '2', type: 'delivery.assigned', occurredAt: '', data: { orderId: 'abcdef12-x', customerId: 'cust', restaurantId: 'r', ownerId: 'own', partnerId: 'p' } });
    expect(n.map((x) => x.userId).sort()).toEqual(['cust', 'own', 'p']);
  });
  it('notifies only the customer for kitchen progress', () => {
    expect(planNotifications(data('PREPARING')).map((x) => x.userId)).toEqual(['cust']);
  });
  it('ignores unrelated event types', () => {
    expect(planNotifications({ eventId: '3', type: 'something.else', occurredAt: '', data: {} })).toEqual([]);
  });
});
