import { Router } from 'express';
import { z } from 'zod';
import { cached } from '../../infra/cache/cache';
import { prisma } from '../../infra/db/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth';
import { AppError } from '../../shared/errors/AppError';
import { pageMeta, paginationSchema } from '../../shared/utils/pagination';

export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('ADMIN'));

// Aggregates over the whole orders table are comparatively expensive, so they're cached for a few seconds.
adminRouter.get('/stats', async (_req, res) => {
  const stats = await cached('admin_stats', 'admin:stats', 10, async () => {
    const [users, restaurants, ordersByStatus, revenue, onlinePartners, pendingOutbox] = await Promise.all([
      prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
      prisma.restaurant.count(),
      prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.order.aggregate({ where: { status: 'DELIVERED' }, _sum: { totalCents: true }, _count: { _all: true } }),
      prisma.deliveryPartnerProfile.count({ where: { isAvailable: true } }),
      prisma.outboxEvent.count({ where: { publishedAt: null } }),
    ]);
    return {
      users: Object.fromEntries(users.map((u) => [u.role, u._count._all])),
      restaurants,
      ordersByStatus: Object.fromEntries(ordersByStatus.map((o) => [o.status, o._count._all])),
      deliveredOrders: revenue._count._all,
      deliveredRevenueCents: revenue._sum.totalCents ?? 0,
      availablePartners: onlinePartners,
      pendingOutboxEvents: pendingOutbox,
      generatedAt: new Date().toISOString(),
    };
  });
  res.json(stats);
});

adminRouter.get('/users', async (req, res) => {
  const q = paginationSchema.extend({ role: z.enum(['CUSTOMER', 'RESTAURANT_OWNER', 'DELIVERY_PARTNER', 'ADMIN']).optional() }).parse(req.query);
  const where = q.role ? { role: q.role } : {};
  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit,
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    }),
    prisma.user.count({ where }),
  ]);
  res.json({ data, meta: pageMeta(q.page, q.limit, total) });
});

adminRouter.patch('/users/:id/active', async (req, res) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw AppError.notFound('User not found');
  if (target.role === 'ADMIN') throw AppError.forbidden('Admin accounts cannot be disabled here');
  const user = await prisma.user.update({ where: { id }, data: { isActive }, select: { id: true, email: true, isActive: true } });
  res.json({ user });
});

adminRouter.get('/orders', async (req, res) => {
  const q = paginationSchema.extend({
    status: z.enum(['PLACED', 'PAID', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED', 'CANCELLED', 'REJECTED', 'PAYMENT_FAILED']).optional(),
  }).parse(req.query);
  const where = q.status ? { status: q.status } : {};
  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where, orderBy: { placedAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit,
      select: { id: true, status: true, totalCents: true, placedAt: true, restaurant: { select: { name: true } }, customer: { select: { name: true } } },
    }),
    prisma.order.count({ where }),
  ]);
  res.json({ data, meta: pageMeta(q.page, q.limit, total) });
});
