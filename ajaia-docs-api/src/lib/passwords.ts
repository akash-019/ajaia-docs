import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

/** scrypt with a random per-password salt, stored as `scrypt$<salt>$<hash>` (base64). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  const [scheme, salt, hash] = (stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Hash checked when the email is unknown, so response time does not reveal which emails exist. */
export const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));
