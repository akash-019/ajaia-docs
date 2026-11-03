import type { Request, Response } from 'express';
import { HttpError } from '../lib/http-error.js';
import type { AttachmentModel, AttachmentRecord } from '../models/attachment.model.js';
import type { AccessService, Role } from '../services/access.service.js';
import { checkAttachment, cleanFilename } from '../services/attachment.service.js';
import type { CollabService } from '../services/collab.service.js';
import { attachmentView } from '../views/attachment.view.js';

interface Deps {
  attachments: AttachmentModel;
  access: AccessService;
  collab: CollabService;
}

/** The owner may delete any attachment; editors may delete the ones they uploaded. */
const canDelete = (role: Role, userId: string, a: AttachmentRecord) =>
  role === 'owner' || (role === 'editor' && a.uploaderId === userId);

const attachmentNotFound = () => new HttpError(404, 'Attachment not found');

/** Files attached to a document: anyone with access can list and download; editors can upload. */
export function createAttachmentsController({ attachments, access, collab }: Deps) {
  return {
    list(req: Request, res: Response) {
      const userId = req.user!.id;
      const { doc, role } = access.requireAccess(String(req.params.id), userId);
      res.json(attachments.listForDocument(doc.id).map((a) => attachmentView(a, canDelete(role, userId, a))));
    },

    upload(req: Request, res: Response) {
      const { doc } = access.requireEditor(String(req.params.id), req.user!.id);
      if (!req.file) throw new HttpError(400, 'Attach a file in the "file" field');
      const filename = cleanFilename(req.file.originalname);
      const contentType = checkAttachment(filename, req.file.size, attachments.countForDocument(doc.id));

      const id = attachments.create({
        documentId: doc.id,
        uploaderId: req.user!.id,
        filename,
        contentType,
        data: req.file.buffer,
      });
      collab.attachmentsChanged(doc.id);
      res.status(201).json(attachmentView(attachments.find(doc.id, id)!, true));
    },

    /** Always served as a download, with a type we chose, so a file can never run in our origin. */
    download(req: Request, res: Response) {
      const { doc } = access.requireAccess(String(req.params.id), req.user!.id);
      const file = attachments.findWithData(doc.id, String(req.params.attachmentId));
      if (!file) throw attachmentNotFound();
      res.attachment(file.filename); // Content-Disposition: attachment (RFC 5987 for non-ASCII names)
      res.set({
        'Content-Type': file.contentType,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'private, no-store',
      });
      res.send(Buffer.from(file.data));
    },

    remove(req: Request, res: Response) {
      const userId = req.user!.id;
      const { doc, role } = access.requireEditor(String(req.params.id), userId);
      const attachment = attachments.find(doc.id, String(req.params.attachmentId));
      if (!attachment) throw attachmentNotFound();
      if (!canDelete(role, userId, attachment)) throw new HttpError(403, 'You can only delete attachments you uploaded');
      attachments.delete(doc.id, attachment.id);
      collab.attachmentsChanged(doc.id);
      res.status(204).end();
    },
  };
}

export type AttachmentsController = ReturnType<typeof createAttachmentsController>;
