import { Router } from 'express';
import { authenticate, currentUser, requireRole } from '../../shared/middleware/auth';
import {
  createCategorySchema, createItemSchema, createRestaurantSchema, idParam,
  listRestaurantsQuery, updateItemSchema, updateRestaurantSchema,
} from './restaurants.schemas';
import * as service from './restaurants.service';

export const restaurantsRouter = Router();
export const menuItemsRouter = Router();

const owner = [authenticate, requireRole('RESTAURANT_OWNER', 'ADMIN')];

// ---- public (cached) ----
restaurantsRouter.get('/', async (req, res) => {
  res.json(await service.listRestaurants(listRestaurantsQuery.parse(req.query)));
});

// ---- owner ---- (declared before '/:id' so "mine" isn't parsed as an id)
restaurantsRouter.get('/mine', ...owner, async (req, res) => {
  res.json({ restaurants: await service.myRestaurants(currentUser(req)) });
});
restaurantsRouter.post('/', ...owner, async (req, res) => {
  const restaurant = await service.createRestaurant(currentUser(req), createRestaurantSchema.parse(req.body));
  res.status(201).json({ restaurant });
});

restaurantsRouter.get('/:id', async (req, res) => {
  res.json(await service.getRestaurant(idParam.parse(req.params).id));
});
restaurantsRouter.patch('/:id', ...owner, async (req, res) => {
  const restaurant = await service.updateRestaurant(currentUser(req), idParam.parse(req.params).id, updateRestaurantSchema.parse(req.body));
  res.json({ restaurant });
});
restaurantsRouter.get('/:id/menu/manage', ...owner, async (req, res) => {
  res.json(await service.manageMenu(currentUser(req), idParam.parse(req.params).id));
});
restaurantsRouter.post('/:id/categories', ...owner, async (req, res) => {
  const category = await service.createCategory(currentUser(req), idParam.parse(req.params).id, createCategorySchema.parse(req.body));
  res.status(201).json({ category });
});
restaurantsRouter.post('/:id/items', ...owner, async (req, res) => {
  const item = await service.createItem(currentUser(req), idParam.parse(req.params).id, createItemSchema.parse(req.body));
  res.status(201).json({ item });
});

menuItemsRouter.patch('/:id', ...owner, async (req, res) => {
  const item = await service.updateItem(currentUser(req), idParam.parse(req.params).id, updateItemSchema.parse(req.body));
  res.json({ item });
});
menuItemsRouter.delete('/:id', ...owner, async (req, res) => {
  await service.deleteItem(currentUser(req), idParam.parse(req.params).id);
  res.status(204).end();
});
