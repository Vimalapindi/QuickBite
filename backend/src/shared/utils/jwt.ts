import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../../config/env';

export interface AuthUser {
  id: string;
  role: Role;
}

export function signToken(user: AuthUser): string {
  return jwt.sign({ role: user.role }, env.JWT_SECRET, {
    subject: user.id,
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

/** Returns null for any invalid/expired token (never throws). */
export function verifyToken(token: string): AuthUser | null {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof p === 'string' || !p.sub || typeof p.role !== 'string') return null;
    return { id: p.sub, role: p.role as Role };
  } catch {
    return null;
  }
}
