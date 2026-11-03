import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './passwords.js';
import { toPlainText } from './sanitize.js';

/** Node's built-in SQLite: no native addon to compile, so it runs on any host with Node >= 22.13. */
export type Db = DatabaseSync;

/** Demo accounts for reviewers. Passwords are stored hashed; this one is documented in the README. */
export const DEMO_PASSWORD = 'demo1234';

export const SEED_USERS = [
  { id: 'u_alice', email: 'alice@ajaia.dev', name: 'Alice Owner' },
  { id: 'u_bob', email: 'bob@ajaia.dev', name: 'Bob Editor' },
  { id: 'u_carol', email: 'carol@ajaia.dev', name: 'Carol Viewer' },
];

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
`;

const WELCOME_DOC = `<h1>Welcome to Ajaia Docs</h1>
<p>This document is owned by <strong>Alice</strong> and shared with <strong>Bob</strong> (can edit) and <strong>Carol</strong> (view only). Sign out and sign in as another demo account to see each side.</p>
<h2>Try it</h2>
<ul><li><p>Format text with the toolbar: <strong>bold</strong>, <em>italic</em>, <u>underline</u>, headings and lists.</p></li><li><p>Rename the document by clicking its title.</p></li><li><p>Import a .txt, .md or .docx file from the documents list.</p></li></ul>
<ol><li><p>Changes save automatically and appear live for everyone who has the document open.</p></li><li><p>Open it as two users side by side to see each other's cursors.</p></li></ol>`;

/** Creates a shared welcome document the first time the app boots, so reviewers can see sharing immediately. */
function seedDemoDocument(db: Db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number };
  if (count > 0) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO documents (id, owner_id, title, content, search_text, version, created_at, updated_at)
     VALUES ('welcome', 'u_alice', 'Welcome to Ajaia Docs', ?, ?, 1, ?, ?)`,
  ).run(WELCOME_DOC, toPlainText(WELCOME_DOC), now, now);
  const share = db.prepare('INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)');
  share.run('welcome', 'u_bob', 'editor', now);
  share.run('welcome', 'u_carol', 'viewer', now);
}

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

  const insertUser = db.prepare('INSERT OR IGNORE INTO users (id, email, name) VALUES (@id, @email, @name)');
  const hasPassword = db.prepare('SELECT password_hash FROM users WHERE id = ?');
  const setPassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  for (const u of SEED_USERS) {
    insertUser.run(u);
    const row = hasPassword.get(u.id) as { password_hash: string | null };
    if (!row.password_hash) setPassword.run(hashPassword(DEMO_PASSWORD), u.id);
  }
  if (seedDemoDocs) seedDemoDocument(db);
  return db;
}
