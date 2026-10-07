import { Prisma } from '@prisma/client';

export function isUniqueViolation(e: unknown, field?: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  if (!field) return true;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return JSON.stringify(target ?? e.message).includes(field);
}
