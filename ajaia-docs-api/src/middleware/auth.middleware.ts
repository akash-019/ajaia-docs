import type { RequestHandler } from 'express';
import { HttpError } from '../lib/http-error.js';
import type { User, UserModel } from '../models/user.model.js';
import { SESSION_COOKIE, type Session, type SessionService } from '../services/session.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      authSession?: Session;
    }
  }
}

export interface SessionHooks {
  /** A session's expiry moved forward (keep its live connections open longer). */
  onRenew?(session: Session): void;
  /** A session signed out (close its live connections). */
  onEnd?(sid: string): void;
}

/** Resolves the signed-in user from the session cookie and renews the token when due (sliding expiry). */
export function loadUser(users: UserModel, sessions: SessionService, hooks: SessionHooks = {}): RequestHandler {
  return (req, res, next) => {
    const session = sessions.verify(req.cookies?.[SESSION_COOKIE]);
    const user = session && users.findById(session.userId);
    if (session && user) {
      req.user = user;
      req.authSession = session;
      const renewed = sessions.renewIfDue(session);
      if (renewed) {
        sessions.setCookie(res, renewed.token, renewed.session);
        req.authSession = renewed.session;
        hooks.onRenew?.(renewed.session);
      }
    }
    next();
  };
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  next();
};
