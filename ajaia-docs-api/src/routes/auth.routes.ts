import { Router } from 'express';
import type { AuthController } from '../controllers/auth.controller.js';
import type { UsersController } from '../controllers/users.controller.js';
import { requireUser } from '../middleware/auth.middleware.js';

/** Mounted at /api. */
export function authRoutes(auth: AuthController, users: UsersController): Router {
  const router = Router();
  router.post('/auth/login', auth.login);
  router.post('/auth/logout', auth.logout);
  router.get('/auth/me', requireUser, auth.me);
  router.get('/users', requireUser, users.list);
  return router;
}
