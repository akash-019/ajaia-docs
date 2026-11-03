import { Router } from 'express';
import type { DocumentsController } from '../controllers/documents.controller.js';
import type { SharesController } from '../controllers/shares.controller.js';
import { requireUser } from '../middleware/auth.middleware.js';
import { uploadSingleFile } from '../middleware/upload.middleware.js';

/** Mounted at /api/documents. Every route requires a signed-in user. */
export function documentRoutes(documents: DocumentsController, shares: SharesController): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', documents.list);
  router.post('/', documents.create);
  router.post('/import', uploadSingleFile, documents.importFile);
  router.get('/:id', documents.show);
  router.patch('/:id', documents.rename);
  router.delete('/:id', documents.remove);
  router.get('/:id/export', documents.exportFile);

  router.get('/:id/shares', shares.list);
  router.post('/:id/shares', shares.grant);
  router.delete('/:id/shares/:userId', shares.revoke);

  return router;
}
