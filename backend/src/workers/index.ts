import http from 'node:http';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { prisma } from '../infra/db/prisma';
import { registry } from '../infra/metrics/metrics';
import { Broker } from '../infra/queue/rabbit';
import { closeEmitter, emitToRooms } from '../infra/realtime/emitter';
import { ADMIN_ROOM, orderRoom, restaurantRoom, userRoom } from '../infra/realtime/rooms';
import { NoPartnerAvailable, assignPartner } from '../modules/delivery/delivery.service';
import { processPayment } from '../modules/payments/payment.service';
import { DELIVERY_ASSIGNED, type DeliveryAssignedData, type EventEnvelope, type OrderEventData } from '../shared/events';
import { isUniqueViolation } from '../shared/utils/prismaErrors';
import { planNotifications } from './notificationRules';
import { OutboxRelay } from './outboxRelay';

export const QUEUES = {
  payment: `${env.QUEUE_PREFIX}.payment`,
  delivery: `${env.QUEUE_PREFIX}.delivery`,
  notification: `${env.QUEUE_PREFIX}.notification`,
};

/** Persist notifications (idempotently) and push everything to the browsers in real time. */
async function handleNotification(evt: EventEnvelope): Promise<void> {
  // 1) Durable notifications. (userId, eventId) is unique => redelivered events don't create duplicates.
  for (const n of planNotifications(evt)) {
    try {
      const row = await prisma.notification.create({ data: { ...n, eventId: evt.eventId, payload: { type: evt.type } } });
      await emitToRooms([userRoom(n.userId)], 'notification:new', row);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // duplicate delivery of the same event: already handled
    }
  }

  // 2) Live order status for anyone watching: customer, the restaurant's dashboard, admins, order room.
  if (evt.type === DELIVERY_ASSIGNED) {
    const d = evt.data as DeliveryAssignedData;
    await emitToRooms([orderRoom(d.orderId), userRoom(d.customerId), userRoom(d.partnerId), restaurantRoom(d.restaurantId)], 'delivery:assigned', {
      orderId: d.orderId, partnerId: d.partnerId, seq: Number(evt.eventId), at: evt.occurredAt,
    });
  } else if (evt.type.startsWith('order.')) {
    const o = evt.data as OrderEventData;
    await emitToRooms([orderRoom(o.orderId), userRoom(o.customerId), restaurantRoom(o.restaurantId), ADMIN_ROOM], 'order:status', {
      // seq = monotonic outbox id. Consumers run concurrently, so delivery order isn't guaranteed; clients ignore events with a lower seq.
      orderId: o.orderId, from: o.from, status: o.to, seq: Number(evt.eventId), at: evt.occurredAt,
    });
  }
}

export interface WorkerHandle {
  broker: Broker;
  relay: OutboxRelay;
  stop(): Promise<void>;
}

export async function startWorker(opts: { metricsPort?: number | null } = {}): Promise<WorkerHandle> {
  const broker = new Broker();
  await broker.connect();

  await broker.consume({ queue: QUEUES.payment, bindings: ['order.placed'], prefetch: 20 }, async (evt) => {
    await processPayment((evt.data as OrderEventData).orderId);
  });

  await broker.consume(
    { queue: QUEUES.delivery, bindings: ['order.confirmed'], prefetch: 10, retryDelayMs: env.DELIVERY_RETRY_DELAY_MS, maxAttempts: env.DELIVERY_MAX_ATTEMPTS },
    async (evt) => {
      try {
        await assignPartner((evt.data as OrderEventData).orderId);
      } catch (e) {
        if (e instanceof NoPartnerAvailable) logger.info({ orderId: (evt.data as OrderEventData).orderId }, 'no partner free, will retry');
        throw e; // -> retry queue
      }
    },
  );

  await broker.consume({ queue: QUEUES.notification, bindings: ['order.*', 'delivery.*'], prefetch: 50 }, handleNotification);

  const relay = new OutboxRelay(broker);
  relay.start();

  let metricsServer: http.Server | undefined;
  const port = opts.metricsPort === undefined ? env.WORKER_METRICS_PORT : opts.metricsPort;
  if (port) {
    metricsServer = http.createServer(async (req, res) => {
      if (req.url === '/metrics') {
        res.setHeader('Content-Type', registry.contentType);
        res.end(await registry.metrics());
      } else if (req.url === '/health/live') {
        res.end('ok');
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    metricsServer.listen(port, () => logger.info(`worker metrics on :${port}`));
  }

  logger.info('worker started: outbox relay + payment, delivery, notification consumers');
  return {
    broker,
    relay,
    async stop() {
      await relay.stop();
      await broker.close();
      await closeEmitter();
      await new Promise<void>((r) => (metricsServer ? metricsServer.close(() => r()) : r()));
    },
  };
}
