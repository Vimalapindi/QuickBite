import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentUser, requireRole } from '../../shared/middleware/auth';
import * as service from './cart.service';

export const cartRouter = Router();
cartRouter.use(authenticate, requireRole('CUSTOMER'));

const setItemSchema = z.object({
  menuItemId: z.uuid(),
  quantity: z.number().int().min(0).max(20),
  replaceCart: z.boolean().default(false),
});

cartRouter.get('/', async (req, res) => {
  res.json(await service.getCart(currentUser(req).id));
});
cartRouter.put('/items', async (req, res) => {
  const b = setItemSchema.parse(req.body);
  res.json(await service.setItem(currentUser(req).id, b.menuItemId, b.quantity, b.replaceCart));
});
cartRouter.delete('/items/:menuItemId', async (req, res) => {
  const { menuItemId } = z.object({ menuItemId: z.uuid() }).parse(req.params);
  res.json(await service.setItem(currentUser(req).id, menuItemId, 0, false));
});
cartRouter.delete('/', async (req, res) => {
  await service.clearCart(currentUser(req).id);
  res.status(204).end();
});
