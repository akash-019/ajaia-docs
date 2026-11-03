import type { Request, Response } from 'express';
import { HttpError } from '../lib/http-error.js';
import { DUMMY_HASH, verifyPassword } from '../lib/passwords.js';
import type { SessionHooks } from '../middleware/auth.middleware.js';
import type { UserModel } from '../models/user.model.js';
import type { LoginLimiter } from '../services/login-limiter.service.js';
import type { SessionService } from '../services/session.service.js';
import { loginBody } from '../validators/auth.validator.js';
import { sessionUserView } from '../views/user.view.js';

interface Deps {
  users: UserModel;
  sessions: SessionService;
  limiter: LoginLimiter;
  hooks?: SessionHooks;
}

/** Email + password sign-in (accounts are seeded; no sign-up). */
export function createAuthController({ users, sessions, limiter, hooks = {} }: Deps) {
  return {
    login(req: Request, res: Response) {
      const { email, password } = loginBody.parse(req.body);
      const key = `${req.ip}|${email}`;
      limiter.assertAllowed(key);

      const user = users.findByEmailWithPassword(email);
      // Same message and similar timing whether the email or the password is wrong.
      const ok = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
      if (!ok || !user) {
        limiter.recordFailure(key);
        throw new HttpError(401, 'Incorrect email or password');
      }
      limiter.recordSuccess(key);

      const { token, session } = sessions.issue(user.id);
      sessions.setCookie(res, token, session);
      res.json(sessionUserView(user, session));
    },

    logout(req: Request, res: Response) {
      if (req.authSession) hooks.onEnd?.(req.authSession.sid);
      sessions.clearCookie(res);
      res.status(204).end();
    },

    /** Current user and when the session expires. Also serves as the client's keep-alive. */
    me(req: Request, res: Response) {
      res.json(sessionUserView(req.user!, req.authSession!));
    },
  };
}

export type AuthController = ReturnType<typeof createAuthController>;
