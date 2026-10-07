import amqp from 'amqplib';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { queueConsumed, queueProcessingDuration, queuePublished } from '../metrics/metrics';
import type { EventEnvelope } from '../../shared/events';

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection['createChannel']>>;
type ConfirmChannel = Awaited<ReturnType<Connection['createConfirmChannel']>>;

export const EXCHANGE = `${env.QUEUE_PREFIX}.events`;
export const DLQ = `${env.QUEUE_PREFIX}.dlq`;

export interface ConsumeOptions {
  queue: string;
  bindings: string[];
  prefetch?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

/**
 * Thin wrapper over amqplib that bakes in the reliability patterns:
 *  - durable exchange/queues + persistent messages (survive a broker restart)
 *  - publisher confirms (we know the broker has the message before marking the outbox row published)
 *  - manual acks + prefetch (backpressure; a crashed worker's unacked messages are redelivered)
 *  - retry-with-delay: failed messages go to `<queue>.retry` (TTL queue that dead-letters back to the work queue),
 *    and after maxAttempts to a dead-letter queue for inspection
 */
export class Broker {
  private conn?: Connection;
  private pubCh?: ConfirmChannel;
  private consumerChannels: Channel[] = [];
  private closing = false;
  onUnexpectedClose?: (err?: Error) => void;

  async connect(): Promise<void> {
    this.conn = await amqp.connect(env.RABBITMQ_URL, { heartbeat: 30 });
    this.conn.on('error', (err: Error) => logger.error({ err: err.message }, 'rabbitmq connection error'));
    this.conn.on('close', () => {
      if (!this.closing) this.onUnexpectedClose?.();
    });
    this.pubCh = await this.conn.createConfirmChannel();
    await this.pubCh.assertExchange(EXCHANGE, 'topic', { durable: true });
    await this.pubCh.assertQueue(DLQ, { durable: true });
  }

  /** Publishes and waits for the broker's confirm. */
  async publish(routingKey: string, envelope: EventEnvelope): Promise<void> {
    if (!this.pubCh) throw new Error('broker not connected');
    this.pubCh.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.eventId,
      type: envelope.type,
      timestamp: Date.now(),
    });
    queuePublished.inc({ routing_key: routingKey });
  }

  async flush(): Promise<void> {
    await this.pubCh?.waitForConfirms();
  }

  async consume(opts: ConsumeOptions, handler: (evt: EventEnvelope) => Promise<void>): Promise<void> {
    if (!this.conn) throw new Error('broker not connected');
    const { queue, bindings } = opts;
    const maxAttempts = opts.maxAttempts ?? 5;
    const retryQueue = `${queue}.retry`;

    const ch = await this.conn.createChannel();
    this.consumerChannels.push(ch);
    // A channel-level protocol error (e.g. PRECONDITION_FAILED) closes ONLY that channel. Make it loud and fatal-to-supervisor.
    ch.on('error', (err: Error) => { logger.error({ queue, err: err.message }, 'rabbitmq channel error'); });
    ch.on('close', () => { if (!this.closing) this.onUnexpectedClose?.(); });
    await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
    await ch.assertQueue(DLQ, { durable: true });
    await ch.assertQueue(queue, { durable: true });
    await ch.assertQueue(retryQueue, {
      durable: true,
      arguments: {
        'x-message-ttl': opts.retryDelayMs ?? 5000,
        'x-dead-letter-exchange': '', // default exchange...
        'x-dead-letter-routing-key': queue, // ...routes expired messages straight back to the work queue
      },
    });
    for (const b of bindings) await ch.bindQueue(queue, EXCHANGE, b);
    await ch.prefetch(opts.prefetch ?? 10);

    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      try {
        await this.handleMessage(ch, queue, maxAttempts, retryQueue, msg, handler);
      } catch (err) {
        // Channel already closed (broker restart / protocol error): unacked messages are redelivered by the broker.
        logger.error({ queue, err: (err as Error).message }, 'consumer callback failed');
      }
    });
  }

  private async handleMessage(
    ch: Channel, queue: string, maxAttempts: number, retryQueue: string,
    msg: amqp.ConsumeMessage, handler: (evt: EventEnvelope) => Promise<void>,
  ): Promise<void> {
    const end = queueProcessingDuration.startTimer({ queue });
    let evt: EventEnvelope;
    try {
      evt = JSON.parse(msg.content.toString()) as EventEnvelope;
    } catch {
      // Poison message: can never succeed, don't retry.
      ch.sendToQueue(DLQ, msg.content, { persistent: true, headers: { 'x-error': 'unparseable', 'x-queue': queue } });
      ch.ack(msg);
      queueConsumed.inc({ queue, result: 'dead' });
      return;
    }
    try {
      await handler(evt);
      ch.ack(msg);
      queueConsumed.inc({ queue, result: 'ok' });
    } catch (err) {
      const attempts = Number(msg.properties.headers?.['x-attempts'] ?? 0) + 1;
      const headers = { ...msg.properties.headers, 'x-attempts': attempts, 'x-error': (err as Error).message };
      if (attempts < maxAttempts) {
        ch.sendToQueue(retryQueue, msg.content, { persistent: true, headers, messageId: msg.properties.messageId });
        queueConsumed.inc({ queue, result: 'retry' });
      } else {
        ch.sendToQueue(DLQ, msg.content, { persistent: true, headers: { ...headers, 'x-queue': queue } });
        queueConsumed.inc({ queue, result: 'dead' });
        logger.error({ queue, eventId: evt.eventId, err: (err as Error).message }, 'message moved to DLQ');
      }
      ch.ack(msg); // the failed message was re-published above, so ack the original
    } finally {
      end();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const ch of this.consumerChannels) await ch.close().catch(() => undefined);
    await this.pubCh?.close().catch(() => undefined);
    await this.conn?.close().catch(() => undefined);
  }
}
