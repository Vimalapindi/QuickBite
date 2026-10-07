import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { cached, getVersion } from '../../infra/cache/cache';
import { prisma } from '../../infra/db/prisma';

export const searchRouter = Router();

const searchQuery = z.object({
  q: z.string().trim().min(2).max(60),
  city: z.string().trim().min(1).optional(),
});

/**
 * Food search: matches restaurant names and dish names.
 * Prisma `contains` + `mode: insensitive` => ILIKE '%q%', which the GIN trigram indexes
 * (Restaurant_name_trgm_idx, MenuItem_name_trgm_idx) can serve without a sequential scan.
 * Results are cached; the key embeds the "restaurants" version so any menu/restaurant edit invalidates it.
 */
searchRouter.get('/', async (req, res) => {
  const { q, city } = searchQuery.parse(req.query);
  const ver = await getVersion('restaurants');
  const hash = createHash('sha1').update(`${q.toLowerCase()}|${city?.toLowerCase() ?? ''}`).digest('hex').slice(0, 16);

  const result = await cached('search', `search:v${ver}:${hash}`, Math.min(env.CACHE_TTL_SEC, 30), async () => {
    const cityFilter = city ? { city: { equals: city, mode: 'insensitive' as const } } : {};
    const [restaurants, items] = await Promise.all([
      prisma.restaurant.findMany({
        where: { name: { contains: q, mode: 'insensitive' }, ...cityFilter },
        select: { id: true, name: true, cuisine: true, city: true, isOpen: true },
        orderBy: { name: 'asc' },
        take: 10,
      }),
      prisma.menuItem.findMany({
        where: { name: { contains: q, mode: 'insensitive' }, isAvailable: true, restaurant: { isOpen: true, ...cityFilter } },
        select: { id: true, name: true, priceCents: true, restaurant: { select: { id: true, name: true } } },
        orderBy: { name: 'asc' },
        take: 20,
      }),
    ]);
    return {
      restaurants,
      items: items.map((i) => ({ id: i.id, name: i.name, priceCents: i.priceCents, restaurantId: i.restaurant.id, restaurantName: i.restaurant.name })),
    };
  });
  res.json(result);
});
