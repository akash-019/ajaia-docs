import type { Db } from '../db/database.js';

export type ShareRole = 'viewer' | 'editor';

export interface ShareRecord {
  userId: string;
  email: string;
  name: string;
  role: ShareRole;
}

/** Owner of a document and the given user's share role on it, if any. */
export interface AccessRecord {
  ownerId: string;
  shareRole: ShareRole | null;
}

/** Data access for document shares. */
export function createShareModel(db: Db) {
  const access = db.prepare(`
    SELECT d.owner_id AS ownerId, s.role AS shareRole
    FROM documents d
    LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = ?
    WHERE d.id = ?`);
  const forDocument = db.prepare(`
    SELECT u.id AS userId, u.email, u.name, s.role
    FROM document_shares s JOIN users u ON u.id = s.user_id
    WHERE s.document_id = ? ORDER BY u.name`);
  const upsert = db.prepare(`
    INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`);
  const remove = db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?');

  return {
    findAccess: (docId: string, userId: string) => access.get(userId, docId) as unknown as AccessRecord | undefined,
    listForDocument: (docId: string) => forDocument.all(docId) as unknown as ShareRecord[],
    /** Grants access, or changes the role if the user already has some. */
    upsert: (docId: string, userId: string, role: ShareRole) => void upsert.run(docId, userId, role, new Date().toISOString()),
    remove: (docId: string, userId: string) => void remove.run(docId, userId),
  };
}

export type ShareModel = ReturnType<typeof createShareModel>;
