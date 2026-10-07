// Runs before every test file: point the app at isolated test resources. Real services, no mocks.
const base = (name: string, fallback: string) => process.env[name] ?? fallback;
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: base('TEST_DATABASE_URL', 'postgresql://quickbite:quickbite_dev_password@localhost:5432/quickbite_test'),
  REDIS_URL: base('TEST_REDIS_URL', 'redis://localhost:6379/1'), // db 1 keeps test keys away from dev data
  RABBITMQ_URL: base('TEST_RABBITMQ_URL', 'amqp://quickbite:quickbite_dev_password@localhost:5672'),
  QUEUE_PREFIX: 'qb_test',
  JWT_SECRET: 'test-secret-test-secret-test-secret',
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_MAX: '1000000',
  AUTH_RATE_LIMIT_MAX: '1000000',
  CACHE_ENABLED: 'true',
  CACHE_TTL_SEC: '60',
  PAYMENT_DELAY_MS: '0',
  PAYMENT_FAILURE_RATE: '0',
  OUTBOX_POLL_MS: '50',
  DELIVERY_RETRY_DELAY_MS: '400',
  DELIVERY_MAX_ATTEMPTS: '6',
  LOG_LEVEL: 'silent',
});
