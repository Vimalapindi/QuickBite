import type { RequestHandler } from 'express';
import type { Role } from '@prisma/client';
import { AppError } from '../errors/AppError';
import { type AuthUser, verifyToken } from '../utils/jwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Verifies the Bearer JWT. Stateless: no DB lookup per request (keeps latency low). */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(AppError.unauthorized());
  const user = verifyToken(header.slice(7));
  if (!user) return next(AppError.unauthorized('Invalid or expired token'));
  req.user = user;
  next();
};

/** RBAC: allow only the listed roles. Must run after `authenticate`. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role)) return next(AppError.forbidden());
    next();
  };

export function currentUser(req: { user?: AuthUser }): AuthUser {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}
