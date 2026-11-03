import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createAuthController } from './controllers/auth.controller.js';
import { createDocumentsController } from './controllers/documents.controller.js';
import { createSharesController } from './controllers/shares.controller.js';
import { createUsersController } from './controllers/users.controller.js';
import type { Db } from './db/database.js';
import { loadUser } from './middleware/auth.middleware.js';
import { apiNotFound, errorHandler } from './middleware/error.middleware.js';
import { createDocumentModel } from './models/document.model.js';
import { createShareModel } from './models/share.model.js';
import { createUserModel } from './models/user.model.js';
import { authRoutes } from './routes/auth.routes.js';
import { documentRoutes } from './routes/documents.routes.js';
import { createAccessService } from './services/access.service.js';
import { createCollabService, type CollabOptions } from './services/collab.service.js';
import { createLoginLimiter } from './services/login-limiter.service.js';
import { createSessionService } from './services/session.service.js';

export interface AppOptions {
  db: Db;
  sessionSecret: string;
  secureCookies?: boolean;
  /** Built Angular app to serve, so UI and API deploy as one service on one origin. */
  staticDir?: string;
  collab?: CollabOptions;
}

/**
 * Composition root: builds models → services → controllers → routes, and returns the
 * Express app plus the real-time collaboration service (attached to the HTTP server by server.ts).
 */
export function createApp({ db, sessionSecret, secureCookies = false, staticDir, collab: collabOptions }: AppOptions) {
  // Models (data access)
  const users = createUserModel(db);
  const documents = createDocumentModel(db);
  const shares = createShareModel(db);

  // Services (business logic)
  const sessions = createSessionService(sessionSecret, secureCookies);
  const access = createAccessService(documents, shares);
  const collab = createCollabService({ documents, access, sessions }, collabOptions);
  const sessionHooks = { onRenew: collab.sessionRenewed, onEnd: collab.sessionEnded };

  // Controllers (HTTP handlers)
  const authController = createAuthController({ users, sessions, limiter: createLoginLimiter(), hooks: sessionHooks });
  const usersController = createUsersController({ users });
  const documentsController = createDocumentsController({ documents, access, collab });
  const sharesController = createSharesController({ shares, users, access, collab });

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(loadUser(users, sessions, sessionHooks));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', authRoutes(authController, usersController));
  app.use('/api/documents', documentRoutes(documentsController, sharesController));
  app.use('/api', apiNotFound);

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
