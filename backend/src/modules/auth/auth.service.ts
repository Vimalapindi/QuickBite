import type { Role, User } from '@prisma/client';
import { prisma } from '../../infra/db/prisma';
import { AppError } from '../../shared/errors/AppError';
import { signToken } from '../../shared/utils/jwt';
import { isUniqueViolation } from '../../shared/utils/prismaErrors';
import { hashPassword, verifyPassword } from './password';
import type { z } from 'zod';
import type { loginSchema, registerSchema } from './auth.schemas';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
}

export function toPublicUser(u: User): PublicUser {
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role };
}

// Verifying against a dummy hash when the email is unknown keeps response time similar,
// so attackers can't use timing to discover which emails are registered.
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '00'.repeat(64);

export async function register(input: z.infer<typeof registerSchema>) {
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        phone: input.phone,
        role: input.role,
        ...(input.role === 'DELIVERY_PARTNER'
          ? { partnerProfile: { create: { vehicleType: input.vehicleType ?? 'BIKE' } } }
          : {}),
      },
    });
    return { user: toPublicUser(user), token: signToken({ id: user.id, role: user.role }) };
  } catch (e) {
    if (isUniqueViolation(e, 'email')) throw AppError.conflict('Email is already registered', 'EMAIL_TAKEN');
    throw e;
  }
}

export async function login(input: z.infer<typeof loginSchema>) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  if (!user.isActive) throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  return { user: toPublicUser(user), token: signToken({ id: user.id, role: user.role }) };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) throw AppError.unauthorized();
  return toPublicUser(user);
}
