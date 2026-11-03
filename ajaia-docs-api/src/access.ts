import type { Db } from './db.js';

export type Role = 'owner' | 'editor' | 'viewer';

/**
 * The single source of truth for document access, used by both the REST routes
 * and the real-time collaboration socket. Returns null when the user has no access.
 */
export function getRole(db: Db, docId: string, userId: string): Role | null {
  const row = db
    .prepare(
      `SELECT d.owner_id AS ownerId, s.role AS shareRole
       FROM documents d
       LEFT JOIN document_shares s ON s.document_id = d.id AND s.user_id = ?
       WHERE d.id = ?`,
    )
    .get(userId, docId) as { ownerId: string; shareRole: Role | null } | undefined;
  if (!row) return null;
  if (row.ownerId === userId) return 'owner';
  return row.shareRole ?? null;
}

export const canEdit = (role: Role | null) => role === 'owner' || role === 'editor';
