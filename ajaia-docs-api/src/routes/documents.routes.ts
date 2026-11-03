import { Router } from 'express';
import type { AttachmentsController } from '../controllers/attachments.controller.js';
import type { DocumentsController } from '../controllers/documents.controller.js';
import type { SharesController } from '../controllers/shares.controller.js';
import { requireUser } from '../middleware/auth.middleware.js';
import { attachmentUpload, importUpload } from '../middleware/upload.middleware.js';

/** Mounted at /api/documents. Every route requires a signed-in user. */
export function documentRoutes(
  documents: DocumentsController,
  shares: SharesController,
  attachments: AttachmentsController,
): Router {
  const router = Router();
  router.use(requireUser);

  router.get('/', documents.list);
  router.post('/', documents.create);
  router.post('/import', importUpload, documents.importFile);
  router.get('/:id', documents.show);
  router.patch('/:id', documents.rename);
  router.delete('/:id', documents.remove);
  router.get('/:id/export', documents.exportFile);
  router.post('/:id/import', importUpload, documents.convertForInsert);

  router.get('/:id/shares', shares.list);
  router.post('/:id/shares', shares.grant);
  router.delete('/:id/shares/:userId', shares.revoke);

  router.get('/:id/attachments', attachments.list);
  router.post('/:id/attachments', attachmentUpload, attachments.upload);
  router.get('/:id/attachments/:attachmentId', attachments.download);
  router.delete('/:id/attachments/:attachmentId', attachments.remove);

  return router;
}
