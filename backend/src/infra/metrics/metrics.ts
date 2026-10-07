import client from 'prom-client';

// One registry per process (API and worker each expose their own /metrics).
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry }); // CPU, memory, event-loop lag, GC

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const cacheOps = new client.Counter({
  name: 'cache_operations_total',
  help: 'Cache lookups by result (hit|miss|error)',
  labelNames: ['cache', 'result'] as const,
  registers: [registry],
});

export const ordersCreated = new client.Counter({
  name: 'orders_created_total',
  help: 'Orders created, by outcome (created|replayed|out_of_stock)',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const orderTransitions = new client.Counter({
  name: 'order_status_transitions_total',
  help: 'Order status transitions',
  labelNames: ['to'] as const,
  registers: [registry],
});

export const rateLimitRejections = new client.Counter({
  name: 'rate_limit_rejections_total',
  help: 'Requests rejected with 429',
  labelNames: ['scope'] as const,
  registers: [registry],
});

export const queuePublished = new client.Counter({
  name: 'queue_messages_published_total',
  help: 'Messages published to RabbitMQ',
  labelNames: ['routing_key'] as const,
  registers: [registry],
});

export const queueConsumed = new client.Counter({
  name: 'queue_messages_consumed_total',
  help: 'Messages consumed from RabbitMQ',
  labelNames: ['queue', 'result'] as const, // ok | retry | dead
  registers: [registry],
});

export const queueProcessingDuration = new client.Histogram({
  name: 'queue_message_processing_seconds',
  help: 'Time spent handling one message',
  labelNames: ['queue'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const outboxBacklog = new client.Gauge({
  name: 'outbox_unpublished_events',
  help: 'Outbox rows not yet published to the broker',
  registers: [registry],
});

export const outboxPublishLag = new client.Histogram({
  name: 'outbox_publish_lag_seconds',
  help: 'Time between an event being written and being published',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const wsConnections = new client.Gauge({
  name: 'websocket_connections',
  help: 'Currently connected Socket.IO clients',
  registers: [registry],
});

export function registerPoolMetrics(pool: { totalCount: number; idleCount: number; waitingCount: number }): void {
  new client.Gauge({
    name: 'db_pool_connections',
    help: 'pg pool connections by state',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });
}
