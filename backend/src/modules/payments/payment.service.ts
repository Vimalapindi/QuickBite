import { setTimeout as sleep } from 'node:timers/promises';
import { env } from '../../config/env';
import { prisma } from '../../infra/db/prisma';
import { applyTransition } from '../orders/orders.service';

export type PaymentResult = 'succeeded' | 'failed' | 'skipped';

/**
 * Simulated payment gateway, executed by the payment worker (never inside an API request).
 * Idempotent: RabbitMQ is at-least-once, so the same `order.placed` event can arrive twice. The conditional
 * UPDATE (status = PENDING) means only the first delivery does any work; duplicates become no-ops.
 * Payment result + order status change commit atomically in one transaction.
 */
export async function processPayment(orderId: string): Promise<PaymentResult> {
  const payment = await prisma.payment.findUnique({ where: { orderId }, include: { order: { select: { status: true } } } });
  if (!payment || payment.status !== 'PENDING' || payment.order.status !== 'PLACED') return 'skipped';

  if (env.PAYMENT_DELAY_MS > 0) await sleep(env.PAYMENT_DELAY_MS); // pretend to call a gateway
  const fail = payment.simulateOutcome === 'FAIL' || Math.random() < env.PAYMENT_FAILURE_RATE;

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: {
        status: fail ? 'FAILED' : 'SUCCEEDED',
        attempts: { increment: 1 },
        failureReason: fail ? 'Simulated card decline' : null,
      },
    });
    if (claimed.count === 0) return 'skipped' as const; // another worker already handled it
    const { afterCommit } = await applyTransition(tx, orderId, fail ? 'PAYMENT_FAILED' : 'PAID', { type: 'SYSTEM', userId: null });
    await Promise.all(afterCommit.map((f) => f()));
    return fail ? ('failed' as const) : ('succeeded' as const);
  });
}
