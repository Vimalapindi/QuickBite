import { env } from '../config/env';
import { logger } from '../config/logger';
import { prisma } from '../infra/db/prisma';
import { outboxBacklog, outboxPublishLag } from '../infra/metrics/metrics';
import type { Broker } from '../infra/queue/rabbit';

interface Row { id: number; eventType: string; payload: unknown; createdAt: Date }
const BATCH = 100;

/**
 * Outbox relay (the "reader" half of the transactional outbox).
 * Each cycle, inside one DB transaction: lock a batch of unpublished rows (FOR UPDATE SKIP LOCKED, so several
 * relay instances can run side by side without publishing the same rows), publish to RabbitMQ, wait for the
 * broker's confirms, then mark them published. If we crash after publishing but before commit the rows are
 * re-published => duplicates are possible, so every consumer is idempotent (at-least-once delivery).
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private lastHousekeeping = 0;

  constructor(private readonly broker: Broker) {}

  start(): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      let published = 0;
      try {
        this.running = true;
        published = await this.runOnce();
        await this.housekeeping();
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'outbox relay cycle failed');
      } finally {
        this.running = false;
      }
      // If the batch was full there is probably more waiting: go again immediately.
      this.timer = setTimeout(loop, published >= BATCH ? 0 : env.OUTBOX_POLL_MS);
    };
    this.timer = setTimeout(loop, 0);
  }

  async runOnce(): Promise<number> {
    return prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Row[]>`
          SELECT "id", "eventType", "payload", "createdAt" FROM "OutboxEvent"
          WHERE "publishedAt" IS NULL ORDER BY "id" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return 0;
        for (const r of rows) {
          await this.broker.publish(r.eventType, {
            eventId: String(r.id), type: r.eventType, occurredAt: r.createdAt.toISOString(), data: r.payload,
          });
        }
        await this.broker.flush();
        const ids = rows.map((r) => r.id);
        await tx.$executeRaw`UPDATE "OutboxEvent" SET "publishedAt" = now() WHERE "id" = ANY(${ids}::int[])`;
        const now = Date.now();
        for (const r of rows) outboxPublishLag.observe(Math.max(0, now - r.createdAt.getTime()) / 1000);
        return rows.length;
      },
      { timeout: 15_000 },
    );
  }

  private async housekeeping(): Promise<void> {
    if (Date.now() - this.lastHousekeeping < 5000) return;
    this.lastHousekeeping = Date.now();
    const backlog = await prisma.outboxEvent.count({ where: { publishedAt: null } }); // served by the partial index
    outboxBacklog.set(backlog);
    // Keep the table small: published rows are only needed briefly for debugging.
    await prisma.$executeRaw`DELETE FROM "OutboxEvent" WHERE "publishedAt" IS NOT NULL AND "publishedAt" < now() - interval '1 hour'`;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }
}
