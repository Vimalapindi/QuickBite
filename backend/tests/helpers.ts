import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { prisma } from '../src/infra/db/prisma';
import { signToken } from '../src/shared/utils/jwt';

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Creates a user directly in the DB (fast: skips password hashing) and returns a valid JWT. */
export async function makeUser(role: Role, overrides: { name?: string } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${randomUUID()}@test.dev`,
      passwordHash: 'x',
      name: overrides.name ?? `${role} test`,
      role,
      ...(role === 'DELIVERY_PARTNER' ? { partnerProfile: { create: {} } } : {}),
    },
  });
  return { user, token: signToken({ id: user.id, role: user.role }), auth: bearer(signToken({ id: user.id, role: user.role })) };
}

export async function makeAddress(userId: string, lat = 17.43, lng = 78.41) {
  return prisma.address.create({ data: { userId, line1: '12 Test Street', city: 'Hyderabad', pincode: '500001', lat, lng } });
}

export async function makeRestaurant(ownerId: string, opts: { stock?: number | null; price?: number; city?: string; name?: string } = {}) {
  const restaurant = await prisma.restaurant.create({
    data: {
      ownerId, name: opts.name ?? `Test Kitchen ${randomUUID().slice(0, 6)}`, cuisine: 'Indian', city: opts.city ?? 'Hyderabad',
      address: '1 Test Road', lat: 17.4, lng: 78.45, deliveryFeeCents: 4000,
    },
  });
  const item = await prisma.menuItem.create({
    data: { restaurantId: restaurant.id, name: `Test Biryani ${randomUUID().slice(0, 6)}`, priceCents: opts.price ?? 20000, stock: opts.stock === undefined ? null : opts.stock },
  });
  return { restaurant, item };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 8000, intervalMs = 40): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
