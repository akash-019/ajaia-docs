import { parse as parseCookies } from 'cookie';
import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Db } from './db.js';
import { envNumber } from './env.js';
import { HttpError } from './errors.js';
import { DUMMY_HASH, verifyPassword } from './passwords.js';

/**
 * Email + password sign-in against hashed passwords (accounts are seeded; no sign-up yet).
 *
 * The session is a JWT (HS256, signed with SESSION_SECRET) kept in an httpOnly cookie:
 * page scripts can't read it, and the browser sends it on API calls and the
 * collaboration WebSocket alike.
 *
 * Expiry: a session ends after SESSION_IDLE_SECONDS without activity, and always
 * SESSION_MAX_SECONDS after sign-in. Activity renews the token (sliding expiry), at
 * most once per RENEW_AFTER_SECONDS, never past the absolute limit.
 */
export const SESSION_COOKIE = 'ajaia_session';
export const SESSION_IDLE_SECONDS = Math.round(envNumber('SESSION_IDLE_HOURS', 8) * 60 * 60);
export const SESSION_MAX_SECONDS = Math.round(envNumber('SESSION_MAX_DAYS', 7) * 24 * 60 * 60);
const RENEW_AFTER_SECONDS = 5 * 60;
const JWT_OPTIONS = { algorithm: 'HS256', issuer: 'ajaia-docs' } as const;

/** Times are Unix seconds. `sid` identifies one sign-in across renewals. */
export interface Session {
  userId: string;
  sid: string;
  authTime: number;
  issuedAt: number;
  expiresAt: number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Issues a token for a new sign-in, or renews one for an existing session (same sid and auth_time). */
export function issueToken(
  secret: string,
  userId: string,
  existing?: Pick<Session, 'sid' | 'authTime'>,
): { token: string; session: Session } {
  const now = nowSeconds();
  const sid = existing?.sid ?? randomUUID();
  const authTime = existing?.authTime ?? now;
  const expiresAt = Math.min(now + SESSION_IDLE_SECONDS, authTime + SESSION_MAX_SECONDS);
  const token = jwt.sign({ sid, auth_time: authTime, exp: expiresAt }, secret, { ...JWT_OPTIONS, subject: userId });
  return { token, session: { userId, sid, authTime, issuedAt: now, expiresAt } };
}

/** Returns the session from a valid, unexpired token; null for anything else. */
export function verifyToken(token: string | undefined, secret: string): Session | null {
  if (!token) return null;
  try {
    // Pinning the algorithm rejects "alg: none" and algorithm-swap tokens.
    const p = jwt.verify(token, secret, { algorithms: [JWT_OPTIONS.algorithm], issuer: JWT_OPTIONS.issuer });
    if (typeof p !== 'object' || typeof p.sub !== 'string' || typeof p.sid !== 'string') return null;
    if (typeof p.auth_time !== 'number' || typeof p.iat !== 'number' || typeof p.exp !== 'number') return null;
    if (p.auth_time + SESSION_MAX_SECONDS < nowSeconds()) return null;
    return { userId: p.sub, sid: p.sid, authTime: p.auth_time, issuedAt: p.iat, expiresAt: p.exp };
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, token: string, session: Session, secure: boolean) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: session.expiresAt * 1000 - Date.now(),
  });
}

export interface User {
  id: string;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      authSession?: Session;
    }
  }
}

/** Reads the session from a raw Cookie header (used by the collaboration socket). */
export function sessionFromCookieHeader(header: string | null | undefined, secret: string): Session | null {
  return verifyToken(header ? parseCookies(header)[SESSION_COOKIE] : undefined, secret);
}

export interface SessionHooks {
  /** A session's expiry moved forward (keep its live connections open longer). */
  onRenew?(session: Session): void;
  /** A session signed out (close its live connections). */
  onEnd?(sid: string): void;
}

/** Resolves the signed-in user and renews the session token when it is due (sliding expiry). */
export function loadUser(db: Db, secret: string, secureCookies: boolean, hooks: SessionHooks = {}): RequestHandler {
  const findUser = db.prepare('SELECT id, email, name FROM users WHERE id = ?');
  return (req, res, next) => {
    const session = verifyToken(req.cookies?.[SESSION_COOKIE], secret);
    const user = session && (findUser.get(session.userId) as User | undefined);
    if (session && user) {
      req.user = user;
      req.authSession = session;
      if (nowSeconds() - session.issuedAt >= RENEW_AFTER_SECONDS) {
        const renewed = issueToken(secret, user.id, session);
        if (renewed.session.expiresAt > session.expiresAt) {
          setSessionCookie(res, renewed.token, renewed.session, secureCookies);
          req.authSession = renewed.session;
          hooks.onRenew?.(renewed.session);
        }
      }
    }
    next();
  };
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  next();
};

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  password: z.string().min(1, 'Password is required').max(200),
});

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

export function authRouter(db: Db, secret: string, secureCookies: boolean, hooks: SessionHooks = {}): Router {
  const router = Router();
  const findByEmail = db.prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?');
  /** Failed attempts per client + email, to slow down password guessing. In memory: resets on restart. */
  const failures = new Map<string, { count: number; until: number }>();

  router.get('/users', requireUser, (_req, res) => {
    res.json(db.prepare('SELECT id, email, name FROM users ORDER BY name').all());
  });

  router.post('/auth/login', (req, res) => {
    const { email, password } = loginBody.parse(req.body);
    const key = `${req.ip}|${email}`;
    const attempts = failures.get(key);
    if (attempts && attempts.count >= MAX_FAILED_LOGINS && attempts.until > Date.now()) {
      throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    }

    const row = findByEmail.get(email) as (User & { password_hash: string | null }) | undefined;
    // Same message and similar timing whether the email or the password is wrong.
    const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH) && !!row;
    if (!ok) {
      const count = attempts && attempts.until > Date.now() ? attempts.count + 1 : 1;
      failures.set(key, { count, until: Date.now() + LOCKOUT_MS });
      throw new HttpError(401, 'Incorrect email or password');
    }
    failures.delete(key);

    const user: User = { id: row.id, email: row.email, name: row.name };
    const { token, session } = issueToken(secret, user.id);
    setSessionCookie(res, token, session, secureCookies);
    res.json({ ...user, expiresAt: session.expiresAt });
  });

  router.post('/auth/logout', (req, res) => {
    if (req.authSession) hooks.onEnd?.(req.authSession.sid);
    res.clearCookie(SESSION_COOKIE);
    res.status(204).end();
  });

  /** Current user and when the session expires (Unix seconds). Also serves as the keep-alive. */
  router.get('/auth/me', requireUser, (req, res) => {
    res.json({ ...req.user, expiresAt: req.authSession!.expiresAt });
  });

  return router;
}
