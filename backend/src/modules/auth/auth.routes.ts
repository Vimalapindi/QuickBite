import { Router } from 'express';
import { env } from '../../config/env';
import { authenticate, currentUser } from '../../shared/middleware/auth';
import { rateLimit } from '../../shared/middleware/rateLimit';
import { loginSchema, registerSchema } from './auth.schemas';
import * as service from './auth.service';

export const authRouter = Router();

// Brute-force protection: much stricter than the global limit, keyed by IP.
const authLimiter = rateLimit({ scope: 'auth', limit: env.AUTH_RATE_LIMIT_MAX });

authRouter.post('/register', authLimiter, async (req, res) => {
  const result = await service.register(registerSchema.parse(req.body));
  res.status(201).json(result);
});

authRouter.post('/login', authLimiter, async (req, res) => {
  res.json(await service.login(loginSchema.parse(req.body)));
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json({ user: await service.getMe(currentUser(req).id) });
});
