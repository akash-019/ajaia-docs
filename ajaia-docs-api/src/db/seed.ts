import { hashPassword } from '../lib/passwords.js';
import { toPlainText } from '../lib/sanitize.js';
import type { Db } from './database.js';

/** Demo accounts for reviewers. Passwords are stored hashed; this one is documented in the README. */
export const DEMO_PASSWORD = 'demo1234';

export const SEED_USERS = [
  { id: 'u_alice', email: 'alice@ajaia.dev', name: 'Alice Owner' },
  { id: 'u_bob', email: 'bob@ajaia.dev', name: 'Bob Editor' },
  { id: 'u_carol', email: 'carol@ajaia.dev', name: 'Carol Viewer' },
];

const WELCOME_DOC = `<h1>Welcome to Ajaia Docs</h1>
<p>This document is owned by <strong>Alice</strong> and shared with <strong>Bob</strong> (can edit) and <strong>Carol</strong> (view only). Sign out and sign in as another demo account to see each side.</p>
<h2>Try it</h2>
<ul><li><p>Format text with the toolbar: <strong>bold</strong>, <em>italic</em>, <u>underline</u>, headings and lists.</p></li><li><p>Rename the document by clicking its title.</p></li><li><p>Import a .txt, .md or .docx file from the documents list.</p></li></ul>
<ol><li><p>Changes save automatically and appear live for everyone who has the document open.</p></li><li><p>Open it as two users side by side to see each other's cursors.</p></li></ol>`;

/** Creates the demo accounts (once) and gives any without a password the demo password. */
export function seedUsers(db: Db) {
  const insertUser = db.prepare('INSERT OR IGNORE INTO users (id, email, name) VALUES (@id, @email, @name)');
  const hasPassword = db.prepare('SELECT password_hash FROM users WHERE id = ?');
  const setPassword = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  for (const u of SEED_USERS) {
    insertUser.run(u);
    const row = hasPassword.get(u.id) as { password_hash: string | null };
    if (!row.password_hash) setPassword.run(hashPassword(DEMO_PASSWORD), u.id);
  }
}

/** Creates a shared welcome document the first time the app boots, so reviewers can see sharing immediately. */
export function seedDemoDocument(db: Db) {
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
