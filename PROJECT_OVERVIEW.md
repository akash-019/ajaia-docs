# Ajaia Docs: Project Overview

A lightweight collaborative document editor: create, format, import, search, share and edit documents together in real time.

- **Live app:** https://ajaia-docs-asjy.onrender.com
- **Source:** https://github.com/akash-019/ajaia-docs
- **Walkthrough video:** https://drive.google.com/file/d/1wWkQDs35DOtcWSzBsJA7RZ2svRgDFbGH/view?usp=sharing
- **Demo accounts** (password `demo1234`): `alice@ajaia.dev` (owner), `bob@ajaia.dev` (editor), `carol@ajaia.dev` (viewer)

---

## 1. How the app works

```
Browser: Angular 21 UI · TipTap editor · Yjs
   │  REST /api/*  (JSON, file uploads)        WebSocket /api/collab  (live editing)
   │  both authenticated by the same JWT in an httpOnly cookie
   ▼
One Node.js server: Express 5 + Hocuspocus  (one URL, one Docker container on Render)
   routes → middleware → controllers → services → models   (MVC)
   ▼
SQLite: users · documents · document_shares · attachments
```

### User flow and what happens behind it

1. **Sign in** with email and password.
   - The password is checked against a scrypt hash. A wrong password and an unknown email get the same message, and repeated failures are locked out for 15 minutes.
   - The server sets a JWT in an httpOnly cookie.
   - The session stays alive while you're active. It ends after 8 hours idle, or 7 days after sign-in at most, and you're sent back to sign-in, then returned to where you were.
2. **The documents list** shows *My documents* and *Shared with me* (with owner name and role badge).
   - **Search** looks at titles and the text inside documents.
   - **New document** creates one and opens it.
   - **Import file** turns a .txt, .md or .docx file into a new document. The server converts and cleans it.
3. **The editor** loads the document, then opens a live-editing WebSocket.
   - The server checks access on connect: viewers get a read-only connection, and their writes are dropped.
   - The document is a **Yjs CRDT**: everyone's typing appears live and merges, with named cursors and avatars.
   - Changes save automatically. The server stores the live-editing state, a cleaned HTML copy and a plain-text copy for search.
   - The toolbar has formatting, plus **Insert file** to place a file's content at the cursor.
4. **Share** by email as *Can edit* or *View only*. Role changes and removed access take effect immediately for anyone who has the document open.
5. **Attachments** can be added, listed, downloaded and deleted, and the list updates live for everyone.
6. **Export** to Markdown (a download), or to PDF through the browser's print dialog.

---

## 2. Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | Angular 21 (standalone components, signals, zoneless), TypeScript 5.9, RxJS |
| Editor | TipTap 3 (on ProseMirror): StarterKit, Collaboration, CollaborationCaret |
| Real-time | Yjs (CRDT), Hocuspocus 4 (server and client), `ws` WebSocket server |
| Backend | Node.js 22, Express 5, TypeScript, MVC structure with dependency injection through factory functions |
| Database | SQLite through Node's built-in `node:sqlite`, with automatic migrations |
| Validation | zod |
| Auth and security | jsonwebtoken (HS256, algorithm pinned), scrypt (`node:crypto`), cookie-parser, sanitize-html, login lockout, forced-download headers for attachments |
| File handling | multer (uploads), mammoth (.docx → HTML), marked (.md → HTML), turndown (HTML → Markdown), @tiptap/html and happy-dom (server-side rendering) |
| Infrastructure | Docker (multi-stage build, non-root user), Render (free plan, `render.yaml` blueprint), GitHub |
| Testing | Vitest, Supertest, Hocuspocus provider over real WebSockets, Puppeteer-core with headless Chrome |

### API structure (MVC)

```
ajaia-docs-api/src/
  app.ts, server.ts   composition root (wires models → services → controllers → routes) and entry point
  routes/             URL → middleware → controller
  controllers/        auth, users, documents, shares, attachments
  models/             all SQL: user, document, share, attachment
  views/              response shapes: document, user, share, attachment
  services/           access rules, JWT sessions, login limiter, live editing, import, export, attachment policy
  middleware/         auth (session + renewal), upload limits, errors
  validators/         zod request schemas
  db/                 schema + migrations, demo seed
  lib/                sanitize, passwords, editor schema, HTTP error
```

---

## 3. Tools used to build it

- **Claude Code (Claude Opus) in VS Code:** planning, writing code, running commands and tests, and checking the deployed site.
- **Angular CLI, npm, tsx** (API auto-reload in development), **concurrently** (`npm run dev` runs both apps).
- **Vitest + Supertest:** API and live-editing tests.
- **Puppeteer + headless Chrome:** browser tests with three users at once, plus screenshots.
- **Git + GitHub:** source control. **Render:** deploys automatically on every push. **GitHub API:** used to watch deploy status.
- **curl and small Node scripts:** production checks. **`.env` files:** local configuration.

---

## 4. Features

### Documents and editing
- Create, rename (click the title), edit and delete (owner only); saves automatically and reopens exactly as left
- Bold, italic, underline, headings H1–H3, bulleted and numbered lists, quote, undo/redo
- Save status: *All changes saved*, *Saving…*, *Offline*, *Live*

### Real-time collaboration
- Live co-editing: typing appears for everyone and simultaneous edits merge
- Named cursors and avatars show who else is in the document
- Renames, access changes and attachment changes appear live for everyone
- Edits made offline sync on reconnect; a tab left open across a server reset recovers safely

### Files
- **Import** a .txt, .md or .docx file as a new editable document (max 2 MB)
- **Insert file** content at the cursor of an open document
- **Attachments:** PDF, images (PNG, JPG, GIF, WebP), Word, Excel, PowerPoint, TXT, MD, CSV, ZIP; up to 5 MB each and 10 per document; always downloaded rather than opened in the app
- **Export** to Markdown (download) and PDF (print layout)

### Sharing and access control
- Owner, editor and viewer roles, enforced by the server on both the REST API and the live connection
- *Shared with me* kept separate from your own documents
- Live upgrade, downgrade and removal of access
- People without access get "not found", so private documents aren't confirmed to exist

### Search
- Searches titles and document text, only among documents you can access, with highlighted matches and snippets

### Sign-in and sessions
- Email and password sign-in with scrypt hashes and lockout after repeated failures
- JWT session in an httpOnly, Secure, SameSite cookie
- Expires after 8 hours idle or 7 days at most; redirects to sign-in and back

### Engineering and operations
- MVC API structure; configuration through `.env` and environment variables
- In production the server refuses to start without a strong secret
- Docker and Render deployment with automatic deploys on push
- Graceful shutdown that saves in-flight edits

---

## 5. Quality and testing

| Suite | What it covers | Result |
| --- | --- | --- |
| API tests (Vitest, 19) | Auth and JWT edge cases, session expiry, access per role, search, import and export, attachments, live sync over real WebSockets | 19/19 |
| Browser suite (Puppeteer, 37 checks) | Three users at once: formatting, import, search, sharing, live editing, live role changes, attachments, export and PDF, session expiry | 37/37 locally and on the live site |
| Reset recovery (`e2e/reset-recovery.mjs`) | A tab left open while the server database is reset doesn't duplicate content | 3/3 |
| Production checks | 44 API-level checks against the live site | 44/44 |

Bugs found by testing the deployed app, then fixed and covered by regression tests:
1. A viewer upgraded to editor while the document was open couldn't save. Opening a document also counted as an edit.
2. A tab left open across a redeploy duplicated the document's content.
3. The search box sometimes swallowed spaces.

---

## 6. Documentation

| File | Contents |
| --- | --- |
| [README.md](README.md) | Setup, running, tests, configuration, deployment |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Priorities, key decisions with tradeoffs, data model, API |
| [AI_WORKFLOW.md](AI_WORKFLOW.md) | How AI was used, what was changed or rejected, how it was verified |
| [SUBMISSION.md](SUBMISSION.md) | What's included, test accounts, status, next steps |
| [docs/screenshots/](docs/screenshots/) | Screenshots of the main flows |
