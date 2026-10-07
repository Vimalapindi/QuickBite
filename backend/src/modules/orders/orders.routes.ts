import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireRole } from '../../shared/middleware/auth';
import { rateLimit } from '../../shared/middleware/rateLimit';
import { AppError } from '../../shared/errors/AppError';
import { paginationSchema } from '../../shared/utils/pagination';
import * as service from './orders.service';

export const ordersRouter = Router();
ordersRouter.use(authenticate);

const statusEnum = z.enum(['PLACED', 'PAID', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED', 'CANCELLED', 'REJECTED', 'PAYMENT_FAILED']);
const idParam = z.object({ id: z.uuid() });

const createOrderSchema = z.object({
  addressId: z.uuid(),
  // Demo/testing hook for the payment simulator: lets you exercise the failure + compensation path.
  paymentSimulation: z.enum(['SUCCESS', 'FAIL']).default('SUCCESS'),
});

// Per-USER limit (not per IP): protects against a single account hammering the write path.
const orderLimiter = rateLimit({ scope: 'orders', limit: 60, windowSec: 60, keyBy: (req) => req.user?.id ?? req.ip ?? 'anon' });

ordersRouter.post('/', requireRole('CUSTOMER'), orderLimiter, async (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key || key.length < 8 || key.length > 128) {
    throw AppError.badRequest('Idempotency-Key header (8-128 chars) is required', { header: 'Idempotency-Key' });
  }
  const { order, replayed } = await service.createOrder(currentUser(req).id, createOrderSchema.parse(req.body), key);
  res.setHeader('Idempotent-Replayed', String(replayed));
  res.status(replayed ? 200 : 201).json({ order, replayed });
});

ordersRouter.get('/', requireRole('CUSTOMER'), async (req, res) => {
  const q = paginationSchema.extend({ status: statusEnum.optional() }).parse(req.query);
  res.json(await service.listMyOrders(currentUser(req).id, q.page, q.limit, q.status));
});

// Restaurant order management (declared before '/:id').
ordersRouter.get('/restaurant/:id', requireRole('RESTAURANT_OWNER', 'ADMIN'), async (req, res) => {
  const q = paginationSchema.extend({ status: statusEnum.optional() }).parse(req.query);
  res.json(await service.listRestaurantOrders(currentUser(req), idParam.parse(req.params).id, q.page, q.limit, q.status));
});

ordersRouter.get('/:id', async (req, res) => {
  res.json(await service.getOrderFor(currentUser(req), idParam.parse(req.params).id));
});

ordersRouter.get('/:id/tracking', async (req, res) => {
  res.json(await service.getTracking(currentUser(req), idParam.parse(req.params).id));
});

ordersRouter.post('/:id/status', async (req, res) => {
  const body = z.object({ status: statusEnum, note: z.string().trim().max(200).optional() }).parse(req.body);
  res.json(await service.changeStatus(currentUser(req), idParam.parse(req.params).id, body.status, body.note));
});
