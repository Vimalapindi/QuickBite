import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../infra/db/prisma';
import { authenticate, currentUser } from '../../shared/middleware/auth';
import { AppError } from '../../shared/errors/AppError';
import { pageMeta, paginationSchema } from '../../shared/utils/pagination';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', async (req, res) => {
  const { page, limit } = paginationSchema.parse(req.query);
  const userId = currentUser(req).id;
  const [data, total, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  res.json({ data, unreadCount: unread, meta: pageMeta(page, limit, total) });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const r = await prisma.notification.updateMany({ where: { userId: currentUser(req).id, readAt: null }, data: { readAt: new Date() } });
  res.json({ updated: r.count });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const { id } = z.object({ id: z.uuid() }).parse(req.params);
  const r = await prisma.notification.updateMany({ where: { id, userId: currentUser(req).id, readAt: null }, data: { readAt: new Date() } });
  if (r.count === 0) {
    const exists = await prisma.notification.findFirst({ where: { id, userId: currentUser(req).id } });
    if (!exists) throw AppError.notFound('Notification not found');
  }
  res.json({ ok: true });
});
