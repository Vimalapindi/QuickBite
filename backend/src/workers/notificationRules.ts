import { DELIVERY_ASSIGNED, type DeliveryAssignedData, type EventEnvelope, type OrderEventData } from '../shared/events';

export interface PlannedNotification {
  userId: string;
  type: string;
  title: string;
  body: string;
}

const ref = (id: string) => `#${id.slice(0, 8)}`;

/** Pure function: event in, notifications out. Unit-testable without any infrastructure. */
export function planNotifications(evt: EventEnvelope): PlannedNotification[] {
  if (evt.type === DELIVERY_ASSIGNED) {
    const d = evt.data as DeliveryAssignedData;
    return [
      { userId: d.partnerId, type: 'DELIVERY_ASSIGNED', title: 'New delivery assigned', body: `Pick up order ${ref(d.orderId)} from the restaurant when it is ready.` },
      { userId: d.customerId, type: 'PARTNER_ASSIGNED', title: 'Delivery partner assigned', body: `A partner has been assigned to order ${ref(d.orderId)}.` },
      { userId: d.ownerId, type: 'PARTNER_ASSIGNED', title: 'Delivery partner assigned', body: `A partner will collect order ${ref(d.orderId)}.` },
    ];
  }
  if (!evt.type.startsWith('order.')) return [];

  const o = evt.data as OrderEventData;
  const customer = (type: string, title: string, body: string): PlannedNotification => ({ userId: o.customerId, type, title, body });
  const owner = (type: string, title: string, body: string): PlannedNotification => ({ userId: o.ownerId, type, title, body });
  const r = ref(o.orderId);

  switch (o.to) {
    case 'PLACED': return [customer('ORDER_PLACED', 'Order placed', `Your order ${r} at ${o.restaurantName} was received. Processing payment...`)];
    case 'PAID': return [
      customer('PAYMENT_SUCCEEDED', 'Payment received', `Payment for order ${r} succeeded. Waiting for ${o.restaurantName} to confirm.`),
      owner('NEW_ORDER', 'New order', `Order ${r} is paid and waiting for you to accept.`),
    ];
    case 'PAYMENT_FAILED': return [customer('PAYMENT_FAILED', 'Payment failed', `Payment for order ${r} was declined. The order was cancelled.`)];
    case 'CONFIRMED': return [customer('ORDER_CONFIRMED', 'Order confirmed', `${o.restaurantName} accepted order ${r}.`)];
    case 'REJECTED': return [customer('ORDER_REJECTED', 'Order rejected', `${o.restaurantName} could not accept order ${r}. You will be refunded.`)];
    case 'PREPARING': return [customer('ORDER_PREPARING', 'Preparing your food', `${o.restaurantName} is preparing order ${r}.`)];
    case 'READY_FOR_PICKUP': return [customer('ORDER_READY', 'Order ready', `Order ${r} is ready and waiting for the delivery partner.`)];
    case 'PICKED_UP': return [customer('ORDER_PICKED_UP', 'On the way', `Order ${r} has been picked up and is on its way.`)];
    case 'DELIVERED': return [
      customer('ORDER_DELIVERED', 'Delivered', `Order ${r} was delivered. Enjoy your meal!`),
      owner('ORDER_DELIVERED', 'Order delivered', `Order ${r} was delivered to the customer.`),
    ];
    case 'CANCELLED': return [
      customer('ORDER_CANCELLED', 'Order cancelled', `Order ${r} was cancelled.`),
      owner('ORDER_CANCELLED', 'Order cancelled', `Order ${r} was cancelled.`),
    ];
    default: return [];
  }
}
