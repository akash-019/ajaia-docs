import { documentNotFound, HttpError } from '../lib/http-error.js';
import type { DocumentModel, DocumentRecord } from '../models/document.model.js';
import type { ShareModel } from '../models/share.model.js';

export type Role = 'owner' | 'editor' | 'viewer';

export const canEdit = (role: Role | null) => role === 'owner' || role === 'editor';

/**
 * The single source of truth for document access, used by the REST controllers and
 * the real-time collaboration socket alike.
 */
export function createAccessService(documents: DocumentModel, shares: ShareModel) {
  /** The user's role on a document, or null when they have no access (or it doesn't exist). */
  function roleOf(docId: string, userId: string): Role | null {
    const access = shares.findAccess(docId, userId);
    if (!access) return null;
    if (access.ownerId === userId) return 'owner';
    return access.shareRole;
  }

  /** Loads a document the user can read. No access → 404, so private ids aren't confirmed. */
  function requireAccess(docId: string, userId: string): { doc: DocumentRecord; role: Role } {
    const doc = documents.findById(docId);
    const role = doc ? roleOf(docId, userId) : null;
    if (!doc || !role) throw documentNotFound();
    return { doc, role };
  }

  function requireEditor(docId: string, userId: string) {
    const result = requireAccess(docId, userId);
    if (!canEdit(result.role)) throw new HttpError(403, 'You have view-only access to this document');
    return result;
  }

  function requireOwner(docId: string, userId: string): DocumentRecord {
    const { doc, role } = requireAccess(docId, userId);
    if (role !== 'owner') throw new HttpError(403, 'Only the owner can do this');
    return doc;
  }

  return { roleOf, requireAccess, requireEditor, requireOwner };
}

export type AccessService = ReturnType<typeof createAccessService>;
