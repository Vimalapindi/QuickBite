import { Emitter } from '@socket.io/redis-emitter';
import type Redis from 'ioredis';
import { createRedisClient } from '../cache/redis';

/**
 * Lets ANY process (API or worker) push events to browsers without owning a WebSocket server:
 * it publishes to Redis, and every API instance's Socket.IO Redis adapter relays it to its connected clients.
 */
let emitter: Emitter | undefined;
let aux: Redis | undefined;

function get(): Emitter {
  if (!emitter) {
    aux = createRedisClient();
    emitter = new Emitter(aux);
  }
  return emitter;
}

type Targetable = { to(room: string): Targetable; emit(event: string, ...args: unknown[]): unknown };

export async function emitToRooms(rooms: string[], event: string, payload: unknown): Promise<void> {
  let target: Targetable = get() as unknown as Targetable;
  for (const room of rooms) target = target.to(room);
  target.emit(event, payload);
}

export async function closeEmitter(): Promise<void> {
  await aux?.quit().catch(() => undefined);
  emitter = undefined;
  aux = undefined;
}
