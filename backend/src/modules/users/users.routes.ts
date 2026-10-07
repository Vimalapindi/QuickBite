import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../infra/db/prisma';
import { authenticate, currentUser } from '../../shared/middleware/auth';

export const usersRouter = Router();
usersRouter.use(authenticate);

const addressSchema = z.object({
  label: z.string().trim().max(50).optional(),
  line1: z.string().trim().min(3).max(200),
  city: z.string().trim().min(1).max(80),
  pincode: z.string().trim().min(3).max(12),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

usersRouter.get('/me/addresses', async (req, res) => {
  const addresses = await prisma.address.findMany({
    where: { userId: currentUser(req).id },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ addresses });
});

usersRouter.post('/me/addresses', async (req, res) => {
  const data = addressSchema.parse(req.body);
  const address = await prisma.address.create({ data: { ...data, userId: currentUser(req).id } });
  res.status(201).json({ address });
});
