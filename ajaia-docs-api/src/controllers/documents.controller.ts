import type { Request, Response } from 'express';
import { HttpError } from '../lib/http-error.js';
import type { DocumentModel } from '../models/document.model.js';
import type { AccessService } from '../services/access.service.js';
import type { CollabService } from '../services/collab.service.js';
import { exportFilename, htmlToMarkdown } from '../services/export.service.js';
import { fileToHtml, titleFromFilename } from '../services/import.service.js';
import { createDocumentBody, renameDocumentBody, searchQuery } from '../validators/document.validator.js';
import { documentListView, documentView } from '../views/document.view.js';

interface Deps {
  documents: DocumentModel;
  access: AccessService;
  collab: CollabService;
}

export function createDocumentsController({ documents, access, collab }: Deps) {
  /** Creates a document owned by the user and responds with it. */
  function createAndRespond(res: Response, ownerId: string, title: string, content: string) {
    const id = documents.create({ ownerId, title, content });
    res.status(201).json(documentView(documents.findById(id)!, 'owner'));
  }

  return {
    /** The user's documents, owned and shared. `?q=` searches titles and text. */
    list(req: Request, res: Response) {
      const userId = req.user!.id;
      const q = searchQuery(req.query.q);
      res.json(documentListView(documents.listOwned(userId, q), documents.listShared(userId, q), q));
    },

    create(req: Request, res: Response) {
      const body = createDocumentBody.parse(req.body ?? {});
      createAndRespond(res, req.user!.id, body.title ?? 'Untitled document', '');
    },

    /** Turns an uploaded .txt/.md/.docx into a new document. */
    async importFile(req: Request, res: Response) {
      if (!req.file) throw new HttpError(400, 'Attach a file in the "file" field');
      const content = await fileToHtml(req.file.originalname, req.file.buffer);
      createAndRespond(res, req.user!.id, titleFromFilename(req.file.originalname), content);
    },

    show(req: Request, res: Response) {
      const { doc, role } = access.requireAccess(String(req.params.id), req.user!.id);
      res.json(documentView(doc, role));
    },

    /** Markdown download. Anyone who can read the document can export it. */
    exportFile(req: Request, res: Response) {
      const { doc } = access.requireAccess(String(req.params.id), req.user!.id);
      if (req.query.format !== 'md') throw new HttpError(400, 'Unsupported export format. Supported: md');
      const markdown = htmlToMarkdown(collab.liveHtml(doc.id) ?? doc.content);
      res
        .type('text/markdown; charset=utf-8')
        .attachment(exportFilename(doc.title, 'md')) // Content-Disposition, RFC 5987-encoded for non-ASCII
        .send(markdown);
    },

    rename(req: Request, res: Response) {
      const { title } = renameDocumentBody.parse(req.body);
      const { doc, role } = access.requireEditor(String(req.params.id), req.user!.id);
      documents.rename(doc.id, title);
      collab.titleChanged(doc.id, title);
      res.json(documentView(documents.findById(doc.id)!, role));
    },

    remove(req: Request, res: Response) {
      const doc = access.requireOwner(String(req.params.id), req.user!.id);
      documents.delete(doc.id);
      collab.documentDeleted(doc.id);
      res.status(204).end();
    },
  };
}

export type DocumentsController = ReturnType<typeof createDocumentsController>;
