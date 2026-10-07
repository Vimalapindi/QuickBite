import type { Prisma } from '@prisma/client';

/**
 * Transactional outbox, writer side.
 * "Save the order" (Postgres) and "publish a message" (RabbitMQ) are two systems; no transaction spans
 * both. So we INSERT the event into OutboxEvent inside the SAME DB transaction as the business change:
 * both commit or neither does. The relay (workers/outboxRelay.ts) publishes unpublished rows afterwards,
 * giving at-least-once delivery.
 */
export async function enqueueEvent(
  tx: Prisma.TransactionClient,
  e: { aggregateType: string; aggregateId: string; type: string; data: object },
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      eventType: e.type,
      payload: e.data as Prisma.InputJsonValue,
    },
  });
}
