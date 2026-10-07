import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Local dev: load the single root-level .env. In Docker the variables come from compose.
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0), // number of reverse proxies in front (nginx = 1)

  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  REDIS_URL: z.string().min(1),
  RABBITMQ_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default('quickbite'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('2h'),

  // Rate limiting (Redis sliding window). Disable only for raw-throughput load tests.
  RATE_LIMIT_ENABLED: bool.default(true),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  // Caching
  CACHE_ENABLED: bool.default(true),
  CACHE_TTL_SEC: z.coerce.number().int().positive().default(60),

  // Payment simulation + delivery assignment (worker)
  PAYMENT_DELAY_MS: z.coerce.number().int().min(0).default(300),
  PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(200),
  DELIVERY_RETRY_DELAY_MS: z.coerce.number().int().positive().default(5000),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(12),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(4001),
  DELIVERY_FEE_CENTS: z.coerce.number().int().min(0).default(4000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
