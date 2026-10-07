import { z } from 'zod';
import { paginationSchema } from '../../shared/utils/pagination';

export const listRestaurantsQuery = paginationSchema.extend({
  city: z.string().trim().min(1).optional(),
  cuisine: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).max(60).optional(),
});

export const createRestaurantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  cuisine: z.string().trim().min(2).max(50),
  city: z.string().trim().min(2).max(80),
  address: z.string().trim().min(3).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  deliveryFeeCents: z.number().int().min(0).max(100_000).optional(),
});
export const updateRestaurantSchema = createRestaurantSchema.partial().extend({ isOpen: z.boolean().optional() });

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export const createItemSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).optional(),
  priceCents: z.number().int().positive().max(10_000_000),
  categoryId: z.uuid().optional(),
  stock: z.number().int().min(0).max(1_000_000).nullable().optional(),
  isAvailable: z.boolean().optional(),
});
export const updateItemSchema = createItemSchema.partial();

export const idParam = z.object({ id: z.uuid() });
