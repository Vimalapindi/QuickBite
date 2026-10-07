import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(7).max(20).optional(),
  // ADMIN accounts can never be self-registered; they are created by the seed script.
  role: z.enum(['CUSTOMER', 'RESTAURANT_OWNER', 'DELIVERY_PARTNER']).default('CUSTOMER'),
  vehicleType: z.enum(['BIKE', 'SCOOTER', 'CYCLE']).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(128),
});
