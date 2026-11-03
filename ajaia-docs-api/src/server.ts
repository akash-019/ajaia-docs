import './config/env.js'; // must be first: loads .env before other modules read process.env
import { createServer } from 'node:http';
import path from 'node:path';
import { createApp } from './app.js';
import { openDb } from './db/database.js';

const port = Number(process.env.PORT ?? 3000);
const isProd = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || 'dev-only-secret';
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  // Anyone who knows the default could forge session tokens, so refuse to run with it.
  console.error('SESSION_SECRET must be set to a random value of at least 32 characters in production.');
  process.exit(1);
}

const db = openDb(process.env.DB_PATH ?? path.resolve('data/ajaia-docs.db'), {
  seedDemoDocs: process.env.SEED_DEMO_DOCS !== 'false',
});
const { app, collab } = createApp({
  db,
  sessionSecret,
  // Secure cookies need HTTPS; set COOKIE_SECURE=false to run a production build over plain HTTP.
  secureCookies: isProd && process.env.COOKIE_SECURE !== 'false',
  staticDir: process.env.STATIC_DIR ?? path.resolve('../ajaia-docs-ui/dist/ajaia-docs-ui/browser'),
});

const server = createServer(app);
collab.attach(server);
server.listen(port, () => {
  console.log(`ajaia-docs-api listening on http://localhost:${port}`);
});

// Persist in-flight edits before the process exits (deploys, Ctrl+C).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    collab.flush();
    collab.close();
    setTimeout(() => process.exit(0), 300);
  });
}
