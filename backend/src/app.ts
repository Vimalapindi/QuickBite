import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './config/logger';
import { registry } from './infra/metrics/metrics';
import { adminRouter } from './modules/admin/admin.routes';
import { authRouter } from './modules/auth/auth.routes';
import { cartRouter } from './modules/cart/cart.routes';
import { deliveryRouter } from './modules/delivery/delivery.routes';
import { healthRouter } from './modules/health/health.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { ordersRouter } from './modules/orders/orders.routes';
import { menuItemsRouter, restaurantsRouter } from './modules/restaurants/restaurants.routes';
import { searchRouter } from './modules/search/search.routes';
import { usersRouter } from './modules/users/users.routes';
import { errorHandler } from './shared/middleware/errorHandler';
import { metricsMiddleware } from './shared/middleware/metrics';
import { notFound } from './shared/middleware/notFound';
import { rateLimit } from './shared/middleware/rateLimit';

// A factory (not a singleton) so tests can build the app without opening a port.
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') || req.url === '/metrics' },
    }),
  );
  app.use(metricsMiddleware);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN.split(','), exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After', 'Idempotent-Replayed'] }));
  app.use(express.json({ limit: '100kb' }));

  // Operational endpoints: not rate limited, not under /api.
  app.use('/health', healthRouter);
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });

  // Global per-IP limiter for the whole API.
  app.use('/api', rateLimit({ scope: 'global', limit: env.RATE_LIMIT_MAX }));
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/restaurants', restaurantsRouter);
  app.use('/api/menu-items', menuItemsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/delivery', deliveryRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
