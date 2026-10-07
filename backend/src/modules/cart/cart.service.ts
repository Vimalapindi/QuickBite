import { prisma } from '../../infra/db/prisma';
import { AppError } from '../../shared/errors/AppError';

const MAX_QTY = 20;

export async function getCart(userId: string) {
  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: { include: { menuItem: true }, orderBy: { id: 'asc' } },
    },
  });
  if (!cart || cart.items.length === 0 || !cart.restaurantId) {
    return { restaurant: null, items: [], subtotalCents: 0, deliveryFeeCents: 0, totalCents: 0 };
  }
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: cart.restaurantId },
    select: { id: true, name: true, isOpen: true, deliveryFeeCents: true },
  });
  const items = cart.items.map((ci) => ({
    menuItemId: ci.menuItemId,
    name: ci.menuItem.name,
    priceCents: ci.menuItem.priceCents,
    quantity: ci.quantity,
    lineTotalCents: ci.menuItem.priceCents * ci.quantity,
    isAvailable: ci.menuItem.isAvailable && (ci.menuItem.stock === null || ci.menuItem.stock >= ci.quantity),
  }));
  const subtotalCents = items.reduce((s, i) => s + i.lineTotalCents, 0);
  const deliveryFeeCents = restaurant?.deliveryFeeCents ?? 0;
  return { restaurant, items, subtotalCents, deliveryFeeCents, totalCents: subtotalCents + deliveryFeeCents };
}

/**
 * Sets the quantity of one item (0 removes it). Enforces the single-restaurant invariant:
 * a cart can only hold dishes from one restaurant; switching requires replaceCart=true.
 */
export async function setItem(userId: string, menuItemId: string, quantity: number, replaceCart: boolean) {
  if (quantity > MAX_QTY) throw AppError.badRequest(`Maximum quantity per item is ${MAX_QTY}`);

  await prisma.$transaction(async (tx) => {
    const item = await tx.menuItem.findUnique({ where: { id: menuItemId }, include: { restaurant: { select: { isOpen: true } } } });
    if (!item) throw AppError.notFound('Menu item not found');

    // upsert on the unique userId => INSERT ... ON CONFLICT, safe under concurrent requests.
    const cart = await tx.cart.upsert({ where: { userId }, create: { userId }, update: {} });

    if (quantity === 0) {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id, menuItemId } });
      const left = await tx.cartItem.count({ where: { cartId: cart.id } });
      if (left === 0) await tx.cart.update({ where: { id: cart.id }, data: { restaurantId: null } });
      return;
    }

    if (!item.isAvailable) throw AppError.conflict('This item is currently unavailable', 'ITEM_UNAVAILABLE');
    if (!item.restaurant.isOpen) throw AppError.conflict('This restaurant is currently closed', 'RESTAURANT_CLOSED');
    if (item.stock !== null && quantity > item.stock) {
      throw AppError.conflict(`Only ${item.stock} left in stock`, 'INSUFFICIENT_STOCK');
    }

    if (cart.restaurantId && cart.restaurantId !== item.restaurantId) {
      const existing = await tx.cartItem.count({ where: { cartId: cart.id } });
      if (existing > 0 && !replaceCart) {
        throw AppError.conflict('Your cart has items from another restaurant', 'CART_RESTAURANT_MISMATCH');
      }
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    }
    if (cart.restaurantId !== item.restaurantId) {
      await tx.cart.update({ where: { id: cart.id }, data: { restaurantId: item.restaurantId } });
    }

    await tx.cartItem.upsert({
      where: { cartId_menuItemId: { cartId: cart.id, menuItemId } },
      create: { cartId: cart.id, menuItemId, quantity },
      update: { quantity },
    });
  });
  return getCart(userId);
}

export async function clearCart(userId: string) {
  const cart = await prisma.cart.findUnique({ where: { userId } });
  if (cart) {
    await prisma.$transaction([
      prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
      prisma.cart.update({ where: { id: cart.id }, data: { restaurantId: null } }),
    ]);
  }
}
