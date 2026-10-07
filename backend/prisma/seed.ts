/**
 * Seed demo data. Idempotent for the demo accounts.
 *   npm run db:seed                  demo data
 *   SEED_BULK_RESTAURANTS=300 npm run db:seed   also create synthetic restaurants/dishes (for meaningful load tests)
 * Demo logins (password for all customers/owners/partners: Password123!):
 *   admin@quickbite.dev / Admin12345!
 */
import path from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { hashPassword } from '../src/modules/auth/password';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const DEMO_PASSWORD = 'Password123!';
const CITY = 'Hyderabad';

async function upsertUser(email: string, name: string, role: 'ADMIN' | 'CUSTOMER' | 'RESTAURANT_OWNER' | 'DELIVERY_PARTNER', password = DEMO_PASSWORD) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email, name, role, passwordHash: await hashPassword(password),
      ...(role === 'DELIVERY_PARTNER' ? { partnerProfile: { create: {} } } : {}),
    },
  });
}

const MENUS: Record<string, { cuisine: string; lat: number; lng: number; categories: Record<string, [string, number, number | null][]> }> = {
  'Spice Route Biryani': {
    cuisine: 'Indian', lat: 17.385, lng: 78.4867,
    categories: {
      Biryani: [['Chicken Dum Biryani', 28000, 50], ['Mutton Biryani', 34000, 30], ['Veg Biryani', 22000, null]],
      Starters: [['Chicken 65', 19000, null], ['Paneer Tikka', 18000, null]],
      Drinks: [['Masala Chaas', 6000, null]],
    },
  },
  'Napoli Slice': {
    cuisine: 'Italian', lat: 17.4399, lng: 78.4983,
    categories: {
      Pizza: [['Margherita', 24900, null], ['Pepperoni', 29900, 40], ['Farmhouse', 27900, null]],
      Sides: [['Garlic Bread', 9900, null], ['Pasta Arrabbiata', 21900, null]],
    },
  },
  'Dragon Wok': {
    cuisine: 'Chinese', lat: 17.4474, lng: 78.3762,
    categories: {
      Noodles: [['Hakka Noodles', 17900, null], ['Schezwan Noodles', 18900, null]],
      Mains: [['Manchurian Gravy', 19900, 25], ['Chilli Paneer', 20900, null]],
    },
  },
};

async function seedDemo() {
  await upsertUser('admin@quickbite.dev', 'QuickBite Admin', 'ADMIN', 'Admin12345!');

  const owners = [];
  for (const [i, name] of Object.keys(MENUS).entries()) {
    const owner = await upsertUser(`owner${i + 1}@quickbite.dev`, `Owner ${i + 1}`, 'RESTAURANT_OWNER');
    owners.push(owner);
    const def = MENUS[name]!;
    const exists = await prisma.restaurant.findFirst({ where: { ownerId: owner.id, name } });
    if (exists) continue;
    const restaurant = await prisma.restaurant.create({
      data: { ownerId: owner.id, name, cuisine: def.cuisine, city: CITY, address: `${name}, Banjara Hills, ${CITY}`, lat: def.lat, lng: def.lng, description: `${def.cuisine} favourites, made fresh.` },
    });
    let order = 0;
    for (const [catName, items] of Object.entries(def.categories)) {
      const cat = await prisma.menuCategory.create({ data: { restaurantId: restaurant.id, name: catName, sortOrder: order++ } });
      await prisma.menuItem.createMany({
        data: items.map(([n, price, stock]) => ({ restaurantId: restaurant.id, categoryId: cat.id, name: n, priceCents: price, stock })),
      });
    }
  }

  for (let i = 1; i <= 3; i++) {
    const c = await upsertUser(`customer${i}@quickbite.dev`, `Customer ${i}`, 'CUSTOMER');
    const has = await prisma.address.count({ where: { userId: c.id } });
    if (!has) {
      await prisma.address.create({ data: { userId: c.id, label: 'Home', line1: `${100 + i}, Road No. ${i}, Jubilee Hills`, city: CITY, pincode: '500033', lat: 17.43 + i / 100, lng: 78.41 + i / 100 } });
    }
  }

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  for (let i = 1; i <= 3; i++) {
    const p = await upsertUser(`partner${i}@quickbite.dev`, `Partner ${i}`, 'DELIVERY_PARTNER');
    const lat = 17.40 + i / 100, lng = 78.45 + i / 100;
    await prisma.deliveryPartnerProfile.update({ where: { userId: p.id }, data: { isAvailable: true, currentLat: lat, currentLng: lng, locationUpdatedAt: new Date() } });
    await redis.geoadd('geo:partners', lng, lat, p.id);
  }
  redis.disconnect();
}

async function seedBulk(count: number) {
  const owner = await upsertUser('bulk-owner@quickbite.dev', 'Bulk Owner', 'RESTAURANT_OWNER');
  const existing = await prisma.restaurant.count({ where: { ownerId: owner.id } });
  if (existing >= count) { console.log(`bulk data already present (${existing} restaurants)`); return; }

  const cuisines = ['Indian', 'Italian', 'Chinese', 'Mexican', 'Thai', 'Japanese', 'Continental', 'Cafe', 'Burgers', 'Desserts'];
  const adjectives = ['Royal', 'Golden', 'Spicy', 'Urban', 'Rustic', 'Tandoori', 'Fresh', 'Smoky', 'Happy', 'Midnight'];
  const nouns = ['Kitchen', 'Bowl', 'Grill', 'House', 'Corner', 'Table', 'Bistro', 'Spoon', 'Oven', 'Express'];
  const dishes = ['Burger', 'Pizza', 'Noodles', 'Biryani', 'Curry', 'Wrap', 'Salad', 'Soup', 'Taco', 'Sushi Roll', 'Pasta', 'Sandwich', 'Dosa', 'Paneer Tikka', 'Brownie'];
  const cities = ['Hyderabad', 'Bengaluru', 'Chennai', 'Mumbai', 'Delhi'];

  const need = count - existing;
  for (let i = 0; i < need; i++) {
    const name = `${adjectives[i % 10]} ${nouns[Math.floor(i / 10) % 10]} ${i}`;
    const r = await prisma.restaurant.create({
      data: {
        ownerId: owner.id, name, cuisine: cuisines[i % cuisines.length]!, city: cities[i % cities.length]!,
        address: `${i} Market Street`, lat: 17.3 + (i % 50) / 100, lng: 78.3 + (i % 50) / 100,
      },
    });
    await prisma.menuItem.createMany({
      data: Array.from({ length: 25 }, (_, j) => ({
        restaurantId: r.id, name: `${adjectives[(i + j) % 10]} ${dishes[j % dishes.length]} ${j}`, priceCents: 9900 + ((i * 31 + j * 17) % 30) * 1000,
      })),
    });
  }
  console.log(`bulk: created ${need} restaurants x 25 dishes`);
}

/** Load-test fixtures: N customers (shared pre-computed password hash => fast), each with an address, plus an unlimited-stock restaurant. */
async function seedLoadtest(n: number) {
  const hash = await hashPassword(DEMO_PASSWORD);
  const owner = await upsertUser('loadtest-owner@quickbite.dev', 'Loadtest Owner', 'RESTAURANT_OWNER');
  let r = await prisma.restaurant.findFirst({ where: { ownerId: owner.id, name: 'Loadtest Kitchen' } });
  if (!r) {
    r = await prisma.restaurant.create({ data: { ownerId: owner.id, name: 'Loadtest Kitchen', cuisine: 'Indian', city: 'Hyderabad', address: '1 Load St', lat: 17.4, lng: 78.45 } });
    await prisma.menuItem.createMany({ data: Array.from({ length: 10 }, (_, i) => ({ restaurantId: r!.id, name: `Loadtest Dish ${i}`, priceCents: 10000 + i * 1000, stock: null })) });
  }
  const have = await prisma.user.count({ where: { email: { startsWith: 'loadtest-user' } } });
  if (have < n) {
    const rows = Array.from({ length: n - have }, (_, i) => ({ email: `loadtest-user${have + i + 1}@quickbite.dev`, name: `Load User ${have + i + 1}`, passwordHash: hash, role: 'CUSTOMER' as const }));
    await prisma.user.createMany({ data: rows, skipDuplicates: true });
  }
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'loadtest-user' } }, select: { id: true, addresses: { select: { id: true }, take: 1 } } });
  const need = users.filter((u) => u.addresses.length === 0);
  if (need.length) await prisma.address.createMany({ data: need.map((u) => ({ userId: u.id, line1: '1 Load Road', city: 'Hyderabad', pincode: '500001', lat: 17.43, lng: 78.41 })) });
  console.log(`loadtest: ${users.length} customers ready (loadtest-user1..${users.length}@quickbite.dev / ${DEMO_PASSWORD}), restaurant "Loadtest Kitchen"`);
}

async function main() {
  await seedDemo();
  const lt = Number(process.env.SEED_LOADTEST_USERS ?? 0);
  if (lt > 0) await seedLoadtest(lt);
  const bulk = Number(process.env.SEED_BULK_RESTAURANTS ?? 0);
  if (bulk > 0) await seedBulk(bulk);
  console.log('Seed complete.\n  admin@quickbite.dev / Admin12345!\n  owner1..3@, customer1..3@, partner1..3@quickbite.dev / Password123!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
