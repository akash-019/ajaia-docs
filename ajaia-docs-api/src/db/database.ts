import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toPlainText } from '../lib/sanitize.js';
import { seedDemoDocument, seedUsers } from './seed.js';

/** Node's built-in SQLite: no native addon to compile, so it runs on any host with Node >= 22.13. */
export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',   -- sanitized HTML rendering
  ydoc       BLOB,                       -- Yjs CRDT state (source of truth once edited live)
  search_text TEXT,                      -- plain text of content, for search
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);

CREATE TABLE IF NOT EXISTS document_shares (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares(user_id);

-- Files attached to a document. Stored in the database so they are exactly as durable
-- as the documents themselves and are removed with them.
CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  uploader_id  TEXT NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  data         BLOB NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_document ON attachments(document_id);
`;

/** Brings databases created by earlier builds up to the current schema. */
function migrate(db: Db) {
  const addColumn = (table: string, column: string, type: string) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn('documents', 'ydoc', 'BLOB');
  addColumn('documents', 'search_text', 'TEXT');
  addColumn('users', 'password_hash', 'TEXT');

  const missing = db.prepare('SELECT id, content FROM documents WHERE search_text IS NULL').all() as { id: string; content: string }[];
  const setText = db.prepare('UPDATE documents SET search_text = ? WHERE id = ?');
  for (const row of missing) setText.run(toPlainText(row.content), row.id);
}

/** Opens (or creates) the database, applies the schema and seeds demo users. Pass ':memory:' for tests. */
export function openDb(file: string, { seedDemoDocs = false } = {}): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  seedUsers(db);
  if (seedDemoDocs) seedDemoDocument(db);
  return db;
}
