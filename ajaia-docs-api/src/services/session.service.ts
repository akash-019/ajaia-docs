import { randomUUID } from 'node:crypto';
import { parse as parseCookies } from 'cookie';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { envNumber } from '../config/env.js';

/**
 * Sessions are JWTs (HS256, signed with SESSION_SECRET) kept in an httpOnly cookie:
 * page scripts can't read them, and the browser sends them on API calls and the
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

export function createSessionService(secret: string, secureCookies: boolean) {
  /** Issues a token for a new sign-in, or renews one for an existing session (same sid and auth_time). */
  function issue(userId: string, existing?: Pick<Session, 'sid' | 'authTime'>): { token: string; session: Session } {
    const now = nowSeconds();
    const sid = existing?.sid ?? randomUUID();
    const authTime = existing?.authTime ?? now;
    const expiresAt = Math.min(now + SESSION_IDLE_SECONDS, authTime + SESSION_MAX_SECONDS);
    const token = jwt.sign({ sid, auth_time: authTime, exp: expiresAt }, secret, { ...JWT_OPTIONS, subject: userId });
    return { token, session: { userId, sid, authTime, issuedAt: now, expiresAt } };
  }

  /** Returns the session from a valid, unexpired token; null for anything else. */
  function verify(token: string | undefined): Session | null {
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

  /** A renewed token when this one is due for renewal and can still be extended; otherwise null. */
  function renewIfDue(session: Session): { token: string; session: Session } | null {
    if (nowSeconds() - session.issuedAt < RENEW_AFTER_SECONDS) return null;
    const renewed = issue(session.userId, session);
    return renewed.session.expiresAt > session.expiresAt ? renewed : null;
  }

  return {
    issue,
    verify,
    renewIfDue,

    /** Reads the session from a raw Cookie header (used by the collaboration socket). */
    fromCookieHeader: (header: string | null | undefined) =>
      verify(header ? parseCookies(header)[SESSION_COOKIE] : undefined),

    setCookie(res: Response, token: string, session: Session) {
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies,
        maxAge: session.expiresAt * 1000 - Date.now(),
      });
    },

    clearCookie: (res: Response) => void res.clearCookie(SESSION_COOKIE),
  };
}

export type SessionService = ReturnType<typeof createSessionService>;
