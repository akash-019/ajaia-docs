import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import { toPlainText } from '../lib/sanitize.js';
import type { ShareRole } from './share.model.js';

export interface DocumentRecord {
  id: string;
  ownerId: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  ownerName: string;
  ownerEmail: string;
}

export interface DocumentSummaryRecord {
  id: string;
  title: string;
  updatedAt: string;
  /** Plain text of the content (for search snippets). */
  text: string | null;
}

export interface SharedDocumentSummaryRecord extends DocumentSummaryRecord {
  role: ShareRole;
  ownerName: string;
}

/** Stored live-editing state of a document. */
export interface DocumentState {
  content: string;
  ydoc: Uint8Array | null;
}

const now = () => new Date().toISOString();
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Data access for documents. Keeps the derived search text in step with content
 * on every write, so callers can't forget it.
 */
export function createDocumentModel(db: Db) {
  const byId = db.prepare(`
    SELECT d.id, d.owner_id AS ownerId, d.title, d.content, d.version,
           d.created_at AS createdAt, d.updated_at AS updatedAt,
           u.name AS ownerName, u.email AS ownerEmail
    FROM documents d JOIN users u ON u.id = d.owner_id
    WHERE d.id = ?`);
  const insert = db.prepare(`
    INSERT INTO documents (id, owner_id, title, content, search_text, version, created_at, updated_at)
    VALUES (@id, @ownerId, @title, @content, @searchText, 1, @now, @now)`);
  const updateTitle = db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM documents WHERE id = ?');

  // Optional case-insensitive search over title and text; LIKE wildcards in the query are literal.
  const matches = `(@pattern IS NULL OR d.title LIKE @pattern ESCAPE '\\' OR d.search_text LIKE @pattern ESCAPE '\\')`;
  const owned = db.prepare(`
    SELECT d.id, d.title, d.updated_at AS updatedAt, d.search_text AS text FROM documents d
    WHERE d.owner_id = @userId AND ${matches} ORDER BY d.updated_at DESC`);
  const shared = db.prepare(`
    SELECT d.id, d.title, d.updated_at AS updatedAt, d.search_text AS text, s.role, u.name AS ownerName
    FROM document_shares s
    JOIN documents d ON d.id = s.document_id
    JOIN users u ON u.id = d.owner_id
    WHERE s.user_id = @userId AND ${matches} ORDER BY d.updated_at DESC`);

  const loadStateStmt = db.prepare('SELECT content, ydoc FROM documents WHERE id = ?');
  const saveStateStmt = db.prepare('UPDATE documents SET ydoc = ? WHERE id = ?');
  const saveContentStmt = db.prepare(
    `UPDATE documents SET ydoc = ?, content = ?, search_text = ?, version = version + 1, updated_at = ? WHERE id = ?`,
  );

  const searchParams = (userId: string, query: string) => ({ userId, pattern: query ? `%${escapeLike(query)}%` : null });

  return {
    findById: (id: string) => byId.get(id) as unknown as DocumentRecord | undefined,

    /** Creates a document and returns its id. */
    create({ ownerId, title, content }: { ownerId: string; title: string; content: string }): string {
      const id = randomUUID();
      insert.run({ id, ownerId, title, content, searchText: toPlainText(content), now: now() });
      return id;
    },

    rename: (id: string, title: string) => void updateTitle.run(title, now(), id),
    delete: (id: string) => void remove.run(id),

    listOwned: (userId: string, query = '') =>
      owned.all(searchParams(userId, query)) as unknown as DocumentSummaryRecord[],
    listShared: (userId: string, query = '') =>
      shared.all(searchParams(userId, query)) as unknown as SharedDocumentSummaryRecord[],

    // Live-editing persistence (used by the collaboration service).
    loadState: (id: string) => loadStateStmt.get(id) as unknown as DocumentState | undefined,
    saveState: (id: string, ydoc: Uint8Array) => void saveStateStmt.run(ydoc, id),
    saveContent: (id: string, ydoc: Uint8Array, html: string) =>
      void saveContentStmt.run(ydoc, html, toPlainText(html), now(), id),
  };
}

export type DocumentModel = ReturnType<typeof createDocumentModel>;
