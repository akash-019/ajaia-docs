import { z } from 'zod';

export const loginBody = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  password: z.string().min(1, 'Password is required').max(200),
});
