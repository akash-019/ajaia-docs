import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { getRole, type Role } from '../access.js';
import { requireUser } from '../auth.js';
import type { Collab } from '../collab.js';
import type { Db } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { exportFilename, htmlToMarkdown } from '../exporters.js';
import { fileToHtml, MAX_UPLOAD_BYTES, titleFromFilename } from '../importers.js';
import { toPlainText } from '../sanitize.js';

interface DocumentRow {
  id: string;
  owner_id: string;
  title: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
  owner_name: string;
  owner_email: string;
}

const title = z.string().trim().min(1, 'Title cannot be empty').max(200, 'Title is too long (max 200 characters)');
const createBody = z.object({ title: title.optional() });
// Content is edited through the real-time channel (see collab.ts); REST only renames.
const updateBody = z.object({ title });
const shareBody = z.object({
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  role: z.enum(['viewer', 'editor']).default('editor'),
});

const now = () => new Date().toISOString();

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A short excerpt of the text around the first match, for search results. */
function snippetAround(text: string, query: string): string | undefined {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return undefined;
  // Widen to whole words so the excerpt doesn't start or end mid-word.
  let start = Math.max(0, at - 60);
  if (start > 0) start = text.indexOf(' ', start) + 1 || start;
  let end = Math.min(text.length, at + query.length + 80);
  if (end < text.length) end = text.lastIndexOf(' ', end) > at + query.length ? text.lastIndexOf(' ', end) : end;
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function documentsRouter(db: Db, collab: Collab): Router {
  const router = Router();
  router.use(requireUser);

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  const selectDoc = db.prepare(`
    SELECT d.id, d.owner_id, d.title, d.content, d.version, d.created_at, d.updated_at,
           u.name AS owner_name, u.email AS owner_email
    FROM documents d JOIN users u ON u.id = d.owner_id
    WHERE d.id = ?`);
  const getDoc = (id: string) => selectDoc.get(id) as unknown as DocumentRow | undefined;
  const insertDoc = db.prepare(`
    INSERT INTO documents (id, owner_id, title, content, search_text, version, created_at, updated_at)
    VALUES (@id, @ownerId, @title, @content, @searchText, 1, @now, @now)`);

  /**
   * Resolves the caller's role on a document. Documents the caller cannot see
   * return 404, not 403, so ids of private documents are not confirmed to exist.
   */
  function loadWithRole(docId: string, userId: string): { doc: DocumentRow; role: Role } {
    const doc = getDoc(docId);
    const role = doc ? getRole(db, docId, userId) : null;
    if (!doc || !role) throw notFound();
    return { doc, role };
  }

  function requireOwner(docId: string, userId: string): DocumentRow {
    const { doc, role } = loadWithRole(docId, userId);
    if (role !== 'owner') throw new HttpError(403, 'Only the owner can do this');
    return doc;
  }

  function toDto(doc: DocumentRow, role: Role) {
    return {
      id: doc.id,
      title: doc.title,
      content: doc.content,
      version: doc.version,
      role,
      owner: { id: doc.owner_id, name: doc.owner_name, email: doc.owner_email },
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
    };
  }

  function createDocument(ownerId: string, docTitle: string, content: string) {
    const id = randomUUID();
    insertDoc.run({ id, ownerId, title: docTitle, content, searchText: toPlainText(content), now: now() });
    return toDto(getDoc(id)!, 'owner');
  }

  /** Lists the caller's documents. `?q=` searches titles and document text (case-insensitive). */
  router.get('/', (req, res) => {
    const userId = req.user!.id;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const pattern = q ? `%${escapeLike(q)}%` : null;
    const matches = `(@pattern IS NULL OR d.title LIKE @pattern ESCAPE '\\' OR d.search_text LIKE @pattern ESCAPE '\\')`;

    const owned = db
      .prepare(
        `SELECT d.id, d.title, d.updated_at AS updatedAt, d.search_text AS text FROM documents d
         WHERE d.owner_id = @userId AND ${matches} ORDER BY d.updated_at DESC`,
      )
      .all({ userId, pattern });
    const shared = db
      .prepare(
        `SELECT d.id, d.title, d.updated_at AS updatedAt, d.search_text AS text, s.role, u.name AS ownerName
         FROM document_shares s
         JOIN documents d ON d.id = s.document_id
         JOIN users u ON u.id = d.owner_id
         WHERE s.user_id = @userId AND ${matches} ORDER BY d.updated_at DESC`,
      )
      .all({ userId, pattern });

    const present = ({ text, ...doc }: Record<string, unknown>) => ({
      ...doc,
      ...(q ? { snippet: snippetAround(String(text ?? ''), q) } : {}),
    });
    res.json({ owned: owned.map(present), shared: shared.map(present) });
  });

  router.post('/', (req, res) => {
    const body = createBody.parse(req.body ?? {});
    res.status(201).json(createDocument(req.user!.id, body.title ?? 'Untitled document', ''));
  });

  router.post('/import', upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Attach a file in the "file" field');
    const content = await fileToHtml(req.file.originalname, req.file.buffer);
    res.status(201).json(createDocument(req.user!.id, titleFromFilename(req.file.originalname), content));
  });

  router.get('/:id', (req, res) => {
    const { doc, role } = loadWithRole(req.params.id, req.user!.id);
    res.json(toDto(doc, role));
  });

  /** Download as Markdown. Anyone who can read the document can export it. */
  router.get('/:id/export', (req, res) => {
    const { doc } = loadWithRole(req.params.id, req.user!.id);
    if (req.query.format !== 'md') throw new HttpError(400, 'Unsupported export format. Supported: md');
    const markdown = htmlToMarkdown(collab.liveHtml(doc.id) ?? doc.content);
    const filename = exportFilename(doc.title, 'md');
    res
      .type('text/markdown; charset=utf-8')
      .attachment(filename) // sets Content-Disposition, RFC 5987-encoded for non-ASCII titles
      .send(markdown);
  });

  router.patch('/:id', (req, res) => {
    const body = updateBody.parse(req.body);
    const { doc, role } = loadWithRole(req.params.id, req.user!.id);
    if (role === 'viewer') throw new HttpError(403, 'You have view-only access to this document');

    db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?').run(body.title, now(), doc.id);
    collab.titleChanged(doc.id, body.title);
    res.json(toDto(getDoc(doc.id)!, role));
  });

  router.delete('/:id', (req, res) => {
    const doc = requireOwner(req.params.id, req.user!.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    collab.documentDeleted(doc.id);
    res.status(204).end();
  });

  // Anyone with access can see who else has access; only the owner can change it.
  router.get('/:id/shares', (req, res) => {
    const { doc } = loadWithRole(req.params.id, req.user!.id);
    const shares = db
      .prepare(
        `SELECT u.id AS userId, u.email, u.name, s.role
         FROM document_shares s JOIN users u ON u.id = s.user_id
         WHERE s.document_id = ? ORDER BY u.name`,
      )
      .all(doc.id);
    res.json(shares);
  });

  router.post('/:id/shares', (req, res) => {
    const body = shareBody.parse(req.body);
    const doc = requireOwner(req.params.id, req.user!.id);
    const target = db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(body.email) as
      | { id: string; email: string; name: string }
      | undefined;
    if (!target) throw new HttpError(404, `No user with email ${body.email}`);
    if (target.id === doc.owner_id) throw new HttpError(400, 'The owner already has full access');

    db.prepare(
      `INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`,
    ).run(doc.id, target.id, body.role, now());
    collab.accessChanged(doc.id, target.id, body.role);
    res.status(201).json({ userId: target.id, email: target.email, name: target.name, role: body.role });
  });

  router.delete('/:id/shares/:userId', (req, res) => {
    const doc = requireOwner(req.params.id, req.user!.id);
    db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?').run(doc.id, req.params.userId);
    collab.accessChanged(doc.id, req.params.userId, null);
    res.status(204).end();
  });

  return router;
}
