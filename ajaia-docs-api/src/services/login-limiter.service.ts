import { HttpError } from '../lib/http-error.js';

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Slows down password guessing: after MAX_FAILED_LOGINS failures for one client + email,
 * further attempts are refused for LOCKOUT_MS. In memory, so it resets on restart.
 */
export function createLoginLimiter() {
  const failures = new Map<string, { count: number; until: number }>();
  const active = (key: string) => {
    const entry = failures.get(key);
    return entry && entry.until > Date.now() ? entry : undefined;
  };

  return {
    /** Throws 429 while the key is locked out. */
    assertAllowed(key: string) {
      const entry = active(key);
      if (entry && entry.count >= MAX_FAILED_LOGINS) {
        throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
      }
    },
    recordFailure(key: string) {
      failures.set(key, { count: (active(key)?.count ?? 0) + 1, until: Date.now() + LOCKOUT_MS });
    },
    recordSuccess: (key: string) => void failures.delete(key),
  };
}

export type LoginLimiter = ReturnType<typeof createLoginLimiter>;
