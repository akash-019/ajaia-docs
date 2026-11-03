import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { authRouter, loadUser } from './auth.js';
import { createCollab, type CollabOptions } from './collab.js';
import type { Db } from './db.js';
import { errorHandler, HttpError } from './errors.js';
import { documentsRouter } from './routes/documents.js';

export interface AppOptions {
  db: Db;
  sessionSecret: string;
  secureCookies?: boolean;
  /** Built Angular app to serve, so UI and API deploy as one service on one origin. */
  staticDir?: string;
  collab?: CollabOptions;
}

/** Builds the Express app plus the real-time collaboration service that shares its auth and data. */
export function createApp({ db, sessionSecret, secureCookies = false, staticDir, collab: collabOptions }: AppOptions) {
  const app = express();
  const collab = createCollab(db, sessionSecret, collabOptions);
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  const sessionHooks = { onRenew: collab.sessionRenewed, onEnd: collab.sessionEnded };
  app.use(loadUser(db, sessionSecret, secureCookies, sessionHooks));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', authRouter(db, sessionSecret, secureCookies, sessionHooks));
  app.use('/api/documents', documentsRouter(db, collab));
  app.use('/api', (_req, _res) => {
    throw new HttpError(404, 'Not found');
  });

  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    // Client-side routes (e.g. /docs/:id) fall back to the SPA shell.
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  app.use(errorHandler);
  return { app, collab };
}
