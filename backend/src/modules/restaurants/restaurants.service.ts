import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { bumpVersion, cached, getVersion, invalidate } from '../../infra/cache/cache';
import { prisma } from '../../infra/db/prisma';
import { AppError } from '../../shared/errors/AppError';
import type { AuthUser } from '../../shared/utils/jwt';
import { pageMeta } from '../../shared/utils/pagination';
import type { z } from 'zod';
import type {
  createCategorySchema, createItemSchema, createRestaurantSchema,
  listRestaurantsQuery, updateItemSchema, updateRestaurantSchema,
} from './restaurants.schemas';

const detailKey = (id: string) => `restaurant:${id}:detail`;
const DETAIL_TTL = Math.min(env.CACHE_TTL_SEC, 30); // short: stock changes don't invalidate (orders re-check stock atomically)

/** Called after anything that changes what listings/search would return. */
async function invalidateRestaurant(id: string) {
  await Promise.all([invalidate(detailKey(id)), bumpVersion('restaurants')]);
}

async function assertCanManage(user: AuthUser, restaurantId: string) {
  const r = await prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { id: true, ownerId: true } });
  if (!r) throw AppError.notFound('Restaurant not found');
  if (user.role !== 'ADMIN' && r.ownerId !== user.id) throw AppError.forbidden('You do not own this restaurant');
  return r;
}

async function assertCanManageItem(user: AuthUser, itemId: string) {
  const item = await prisma.menuItem.findUnique({ where: { id: itemId }, include: { restaurant: { select: { ownerId: true } } } });
  if (!item) throw AppError.notFound('Menu item not found');
  if (user.role !== 'ADMIN' && item.restaurant.ownerId !== user.id) throw AppError.forbidden('You do not own this restaurant');
  return item;
}

export async function listRestaurants(q: z.infer<typeof listRestaurantsQuery>) {
  const ver = await getVersion('restaurants');
  const hash = createHash('sha1').update(JSON.stringify([q.city?.toLowerCase(), q.cuisine?.toLowerCase(), q.q?.toLowerCase(), q.page, q.limit])).digest('hex').slice(0, 16);
  return cached('restaurant_list', `restaurants:list:v${ver}:${hash}`, env.CACHE_TTL_SEC, async () => {
    const where: Prisma.RestaurantWhereInput = {
      ...(q.city ? { city: { equals: q.city, mode: 'insensitive' } } : {}),
      ...(q.cuisine ? { cuisine: { equals: q.cuisine, mode: 'insensitive' } } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.restaurant.findMany({
        where,
        select: { id: true, name: true, description: true, cuisine: true, city: true, isOpen: true, deliveryFeeCents: true },
        orderBy: [{ isOpen: 'desc' }, { name: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prisma.restaurant.count({ where }),
    ]);
    return { data: rows, meta: pageMeta(q.page, q.limit, total) };
  });
}

export async function getRestaurant(id: string) {
  return cached('restaurant_detail', detailKey(id), DETAIL_TTL, async () => {
    const r = await prisma.restaurant.findUnique({
      where: { id },
      include: {
        categories: { orderBy: { sortOrder: 'asc' } },
        items: { orderBy: { name: 'asc' } },
      },
    });
    if (!r) throw AppError.notFound('Restaurant not found');
    const { items, ownerId: _o, ...rest } = r;
    return {
      restaurant: {
        ...rest,
        // Never leak exact inventory publicly: expose only whether it can be ordered.
        items: items.map((i) => ({
          id: i.id, name: i.name, description: i.description, priceCents: i.priceCents, categoryId: i.categoryId,
          isAvailable: i.isAvailable, soldOut: i.stock !== null && i.stock <= 0,
        })),
      },
    };
  });
}

export async function myRestaurants(user: AuthUser) {
  return prisma.restaurant.findMany({ where: { ownerId: user.id }, orderBy: { createdAt: 'desc' } });
}

export async function createRestaurant(user: AuthUser, input: z.infer<typeof createRestaurantSchema>) {
  const r = await prisma.restaurant.create({ data: { ...input, ownerId: user.id } });
  await bumpVersion('restaurants');
  return r;
}

export async function updateRestaurant(user: AuthUser, id: string, input: z.infer<typeof updateRestaurantSchema>) {
  await assertCanManage(user, id);
  const r = await prisma.restaurant.update({ where: { id }, data: input });
  await invalidateRestaurant(id);
  return r;
}

/** Owner-facing menu: includes exact stock, never cached. */
export async function manageMenu(user: AuthUser, restaurantId: string) {
  await assertCanManage(user, restaurantId);
  const [categories, items] = await Promise.all([
    prisma.menuCategory.findMany({ where: { restaurantId }, orderBy: { sortOrder: 'asc' } }),
    prisma.menuItem.findMany({ where: { restaurantId }, orderBy: { name: 'asc' } }),
  ]);
  return { categories, items };
}

export async function createCategory(user: AuthUser, restaurantId: string, input: z.infer<typeof createCategorySchema>) {
  await assertCanManage(user, restaurantId);
  const c = await prisma.menuCategory.create({ data: { ...input, restaurantId } });
  await invalidateRestaurant(restaurantId);
  return c;
}

export async function createItem(user: AuthUser, restaurantId: string, input: z.infer<typeof createItemSchema>) {
  await assertCanManage(user, restaurantId);
  if (input.categoryId) {
    const cat = await prisma.menuCategory.findFirst({ where: { id: input.categoryId, restaurantId } });
    if (!cat) throw AppError.badRequest('categoryId does not belong to this restaurant');
  }
  const item = await prisma.menuItem.create({ data: { ...input, restaurantId } });
  await invalidateRestaurant(restaurantId);
  return item;
}

export async function updateItem(user: AuthUser, itemId: string, input: z.infer<typeof updateItemSchema>) {
  const existing = await assertCanManageItem(user, itemId);
  if (input.categoryId) {
    const cat = await prisma.menuCategory.findFirst({ where: { id: input.categoryId, restaurantId: existing.restaurantId } });
    if (!cat) throw AppError.badRequest('categoryId does not belong to this restaurant');
  }
  const item = await prisma.menuItem.update({ where: { id: itemId }, data: input });
  await invalidateRestaurant(existing.restaurantId);
  return item;
}

export async function deleteItem(user: AuthUser, itemId: string) {
  const existing = await assertCanManageItem(user, itemId);
  await prisma.menuItem.delete({ where: { id: itemId } });
  await invalidateRestaurant(existing.restaurantId);
}
