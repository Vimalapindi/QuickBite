import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireRole } from '../../shared/middleware/auth';
import * as service from './delivery.service';

export const deliveryRouter = Router();
deliveryRouter.use(authenticate, requireRole('DELIVERY_PARTNER'));

deliveryRouter.get('/me', async (req, res) => {
  const scope = z.enum(['active', 'completed']).default('active').parse(req.query.scope);
  res.json(await service.myDeliveries(currentUser(req).id, scope));
});

deliveryRouter.patch('/me/availability', async (req, res) => {
  const { isAvailable } = z.object({ isAvailable: z.boolean() }).parse(req.body);
  const profile = await service.setAvailability(currentUser(req).id, isAvailable);
  res.json({ profile });
});

deliveryRouter.put('/me/location', async (req, res) => {
  const { lat, lng } = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).parse(req.body);
  const r = await service.updateLocation(currentUser(req).id, lat, lng);
  res.json({ ok: true, ...r });
});
