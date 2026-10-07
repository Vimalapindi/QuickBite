import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { verifyToken } from '../../shared/utils/jwt';
import { prisma } from '../db/prisma';
import { wsConnections } from '../metrics/metrics';
import { createRedisClient } from '../cache/redis';
import { ADMIN_ROOM, orderRoom, restaurantRoom, userRoom } from './rooms';

/**
 * Real-time layer. Security model:
 *  - the JWT must be supplied in the handshake (`auth.token`); anonymous sockets are rejected
 *  - each socket auto-joins ONLY its own rooms (user:<id>, restaurant:<id> for owners, admin)
 *  - joining an order room requires proving the user is a participant in that order
 * The Redis adapter lets several API instances share rooms, so any instance can deliver to any client.
 */
export function createSocketServer(httpServer: HttpServer) {
  const pub = createRedisClient();
  const sub = pub.duplicate();
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGIN.split(','), credentials: true },
    adapter: createAdapter(pub, sub),
  });

  io.use((socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : undefined;
    const user = token ? verifyToken(token) : null;
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', async (socket) => {
    const user = socket.data.user as { id: string; role: string };
    wsConnections.inc();
    socket.on('disconnect', () => wsConnections.dec());

    await socket.join(userRoom(user.id));
    if (user.role === 'ADMIN') await socket.join(ADMIN_ROOM);
    if (user.role === 'RESTAURANT_OWNER') {
      const owned = await prisma.restaurant.findMany({ where: { ownerId: user.id }, select: { id: true } });
      await Promise.all(owned.map((r) => socket.join(restaurantRoom(r.id))));
    }
    socket.emit('ready', { userId: user.id });

    socket.on('order:subscribe', async (orderId: unknown, ack?: (r: { ok: boolean; error?: string }) => void) => {
      try {
        if (typeof orderId !== 'string' || !/^[0-9a-f-]{36}$/i.test(orderId)) throw new Error('invalid order id');
        const o = await prisma.order.findUnique({
          where: { id: orderId },
          select: { customerId: true, restaurant: { select: { ownerId: true } }, delivery: { select: { partnerId: true } } },
        });
        const allowed = o && (user.role === 'ADMIN' || o.customerId === user.id || o.restaurant.ownerId === user.id || o.delivery?.partnerId === user.id);
        if (!allowed) throw new Error('not allowed');
        await socket.join(orderRoom(orderId));
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false, error: (e as Error).message });
      }
    });

    socket.on('order:unsubscribe', async (orderId: string) => {
      if (typeof orderId === 'string') await socket.leave(orderRoom(orderId));
    });
  });

  const close = async () => {
    await io.close();
    pub.disconnect();
    sub.disconnect();
  };
  logger.info('socket.io ready');
  return { io, close };
}
