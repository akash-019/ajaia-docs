import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';

/** Attachment metadata (no file bytes). */
export interface AttachmentRecord {
  id: string;
  documentId: string;
  uploaderId: string;
  uploaderName: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface AttachmentFile extends AttachmentRecord {
  data: Uint8Array;
}

const COLUMNS = `a.id, a.document_id AS documentId, a.uploader_id AS uploaderId, u.name AS uploaderName,
  a.filename, a.content_type AS contentType, a.size, a.created_at AS createdAt`;

/** Data access for document attachments. Listing never loads file bytes. */
export function createAttachmentModel(db: Db) {
  const forDocument = db.prepare(`
    SELECT ${COLUMNS} FROM attachments a JOIN users u ON u.id = a.uploader_id
    WHERE a.document_id = ? ORDER BY a.created_at, a.filename`);
  const one = db.prepare(`
    SELECT ${COLUMNS} FROM attachments a JOIN users u ON u.id = a.uploader_id
    WHERE a.document_id = ? AND a.id = ?`);
  const oneWithData = db.prepare(`
    SELECT ${COLUMNS}, a.data FROM attachments a JOIN users u ON u.id = a.uploader_id
    WHERE a.document_id = ? AND a.id = ?`);
  const count = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE document_id = ?');
  const insert = db.prepare(`
    INSERT INTO attachments (id, document_id, uploader_id, filename, content_type, size, data, created_at)
    VALUES (@id, @documentId, @uploaderId, @filename, @contentType, @size, @data, @createdAt)`);
  const remove = db.prepare('DELETE FROM attachments WHERE document_id = ? AND id = ?');

  return {
    listForDocument: (docId: string) => forDocument.all(docId) as unknown as AttachmentRecord[],
    find: (docId: string, id: string) => one.get(docId, id) as unknown as AttachmentRecord | undefined,
    findWithData: (docId: string, id: string) => oneWithData.get(docId, id) as unknown as AttachmentFile | undefined,
    countForDocument: (docId: string) => (count.get(docId) as { n: number }).n,

    /** Stores a file and returns its id. */
    create(input: { documentId: string; uploaderId: string; filename: string; contentType: string; data: Uint8Array }) {
      const id = randomUUID();
      insert.run({ id, ...input, size: input.data.byteLength, createdAt: new Date().toISOString() });
      return id;
    },

    delete: (docId: string, id: string) => void remove.run(docId, id),
  };
}

export type AttachmentModel = ReturnType<typeof createAttachmentModel>;
