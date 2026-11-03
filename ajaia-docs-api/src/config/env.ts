import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads ajaia-docs-api/.env into process.env for local runs (see .env.example).
 * Imported first by server.ts so every module sees the values. Variables already set
 * in the real environment (e.g. on the host) take precedence. No .env in production.
 */
const file = path.resolve(import.meta.dirname, '..', '.env');
// Tests stay independent of local settings.
if (process.env.NODE_ENV !== 'test' && fs.existsSync(file)) process.loadEnvFile(file);

/** Reads a positive number from the environment, falling back to a default. */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}
