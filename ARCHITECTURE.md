# Architecture note

## Shape

```
Browser (Angular 21 + TipTap + Yjs)
   │  REST (JSON, multipart)            WebSocket /api/collab (Yjs sync + presence)
   │  both authenticated by the same JWT in an httpOnly cookie
   ▼
Express 5 API ─────────────── Hocuspocus collaboration server   (one Node process, one port)
   │  access check: access.service  ◄── same rule ──►  checked on socket connect + live updates
   ▼
SQLite (node:sqlite): users · documents (Yjs state + sanitized HTML + search text) · document_shares
```

The UI, REST API and WebSocket ship as one service, one image and one URL. For this scope that removes CORS, cross-site cookies and a second deployment.

## What I prioritized and why

1. **Collaboration that is actually live.** A shared editor that needs a refresh to show someone else's changes doesn't feel collaborative. Documents are **Yjs CRDTs** synced over WebSocket by Hocuspocus and bound to TipTap, so:
   - typing appears for everyone as it happens
   - simultaneous edits merge character by character, with no "someone else saved" conflicts
   - other people's named cursors and avatars are shown
   - edits made while offline sync on reconnect

   (The first version used optimistic locking with a 409 conflict prompt. It was correct but not live, so I replaced it.)
2. **Sharing that is real access control, not just UI.** One service, `access.service.ts`, decides the role, and both the REST routes and the socket use it.
   - The owner can do everything.
   - An editor can write.
   - A viewer gets a **read-only socket**: the server drops their updates even from a modified client.
   - Anyone else gets a 404, or a refused socket.

   Access changes apply to open sessions **immediately**: an upgrade flips the live connection to writable and tells the client, and a removal disconnects the user.
3. **Real sign-in and session timeout.** Email and password with scrypt hashes and timing-safe comparison. Unknown emails and wrong passwords give the same answer, and repeated failures are locked out. The session is a **JWT (HS256, algorithm pinned)** in an **httpOnly, SameSite=Lax cookie**, not localStorage, so page scripts can't read it, and the browser sends it on both REST calls and the WebSocket upgrade.

   The token carries `sid` (one sign-in), `auth_time` and `exp`. Expiry is **8 hours idle and 7 days absolute**.
   - Authenticated requests renew the token at most every 5 minutes (sliding), never past the absolute limit.
   - The UI sends a keep-alive only while the user is actually active, so an idle tab does expire.
   - Because a WebSocket outlives the request that opened it, each live connection carries its session's expiry. A sweep closes expired ones, a renewal over HTTP extends them, and signing out closes that session's connections in other tabs.
   - On any 401 the UI routes to sign-in with a notice and returns the user to where they were.
4. **Search across what you can see.** It matches titles and document text, is scoped in SQL to owned plus shared documents, treats `%`/`_` literally, and returns a snippet. The plain text is kept current on every live save and import.
5. **A safe upload and storage path.** Imports are converted on the server (`marked`, `mammoth`, escaped .txt). Everything stored as HTML passes a sanitize-html allowlist that matches the editor's schema.

## Key decisions

| Decision | Why | Tradeoff |
| --- | --- | --- |
| **MVC layering in the API**: models (all SQL), views (response shapes), controllers (HTTP), plus services, routes, middleware and validators, wired in one composition root (`app.ts`) | Each file has one job: SQL changes stay in models, response changes in views, and access rules in one service shared by REST and the live socket. Factory functions with injected dependencies keep it testable without a DI framework. | More files than a small app strictly needs. |
| **Yjs CRDT + Hocuspocus** for content | Live updates and conflict-free merging; a proven stack that TipTap supports directly. Hocuspocus provides auth hooks, read-only connections and debounced persistence. | More moving parts than REST saves. Content no longer goes through `PATCH`; REST is for metadata only. |
| Store **Yjs state + sanitized HTML + plain text** | The Yjs state gives lossless sync. HTML serves REST, imports and seeding. The plain text is for search. | Three representations, all written through the document model, which derives the search text on every write. |
| Server-side **HTML → Yjs seeding** on first open | Imported and seeded docs start from one shared CRDT history, avoiding duplicate content when two clients seed at once. | The server needs the editor schema (`lib/editor-schema.ts`), which must stay in step with the UI. |
| **JWT in an httpOnly cookie**, sliding 8 h idle / 7 d absolute | A standard signed token with built-in expiry. A cookie works for WebSockets without token plumbing and stays out of reach of XSS. Sliding expiry keeps active users signed in. | Stateless, so a stolen token works until it expires (at most 8 idle hours). Server-side revocation would need a session table. |
| **SQLite via `node:sqlite`** | Zero setup, no paid service, no native addon. better-sqlite3 failed on an older glibc. | Single node, and needs a disk to persist. Moving to Postgres is contained to the data access code. |
| Seeded accounts, **no sign-up** | Keeps scope on the editor; the brief allows seeded users. | Adding accounts means editing the seed. Sign-up is a small next step now that hashing exists. |
| **Attachments stored in SQLite** (bytes in an `attachments` table) | Exactly as durable as the documents they belong to, removed with them in one transaction, and no extra service or paid storage for reviewers. File type comes from an allowlist by extension; downloads are forced (`Content-Disposition: attachment`, `nosniff`, sandbox CSP) so a file can never run in the app's origin. | Fine at 5 MB per file and 10 per document; larger files or volume would move the bytes to object storage (S3 or similar) and keep only metadata in the database. |
| **Markdown export on the server, PDF via browser print** | The server already has the access check and the latest live content. Markdown is lossless for this schema except underline, which is kept as inline `<u>`. Browser print gives a real PDF with selectable text and no extra infrastructure. | Server-side PDF (headless Chrome) would allow one-click download, but at a large cost in image size, memory and cold start on free hosting. Rejected. |
| Two import paths, one converter: **new document** from the list, or **insert at the cursor** of an open document | Both reuse the same server-side conversion and sanitization. Insertion happens in the editor, so it's an ordinary live edit: everyone sees it, undo works, and the socket's read-only rule still applies. | The server only converts on insert; it trusts the editor to place the content, which is fine because the live socket enforces who can write. |
| **Angular 21**, standalone + signals + zoneless; lazy editor route | The requested UI stack. The editor (TipTap + Yjs) loads only when a document is opened. | — |

## Data model

```
users            (id, email UNIQUE, name, password_hash)
documents        (id, owner_id → users, title, content HTML, ydoc BLOB, search_text,
                  version, created_at, updated_at)
document_shares  (document_id → documents ON DELETE CASCADE, user_id → users,
                  role 'viewer'|'editor', PK(document_id, user_id))
attachments      (id, document_id → documents ON DELETE CASCADE, uploader_id → users,
                  filename, content_type, size, data BLOB, created_at)
```

Older databases are migrated in place on boot (new columns added and back-filled).

## API

```
POST /api/auth/login {email, password}   GET /api/auth/me   POST /api/auth/logout
GET  /api/users                          (signed in; share picker)
GET  /api/documents?q=                   → { owned[], shared[] } (+ snippet when searching)
POST /api/documents {title?}             POST /api/documents/import (multipart "file") → new document
POST /api/documents/:id/import           (multipart "file", editors) → sanitized HTML to insert at the cursor
GET  /api/documents/:id                  PATCH /api/documents/:id {title}   DELETE (owner)
GET  /api/documents/:id/export?format=md  (anyone with access; uses live content if the doc is open)
GET  /api/documents/:id/attachments     POST …/attachments (multipart "file", editors)
GET  /api/documents/:id/attachments/:aid (download)   DELETE …/attachments/:aid (owner: any; editor: own)
GET  /api/documents/:id/shares           POST …/shares {email, role}   DELETE …/shares/:userId  (owner)
WS   /api/collab                         Yjs sync + awareness; server pushes title / access / revoked / deleted
```

Validation uses zod and returns 400 with readable messages. Errors are always `{ error }` JSON. Malformed JSON gives 400, a lockout gives 429, and unknown errors give a generic 500 with details only in the server log.

## Quality and verification

- **API tests** (18, Vitest): attachments (allowed types, size and count limits, who can upload, download and delete, safe download headers, removal with the document, live list updates), insert-from-file (editors only, sanitized, viewers 403, outsiders 404), Markdown export (exact output, export → re-import round trip, access), sign-in (wrong password, unknown email, lockout, and forged, expired, wrong-algorithm and `alg:none` JWTs), session timeout (sliding renewal, the 7-day cap, and live connections closed on expiry or sign-out but kept open by activity), the access lifecycle across all roles, search scoping and wildcards, sanitization, import, and **collaboration over real WebSockets**. The socket tests cover live sync, viewer edits dropped server-side, live removal and upgrade, outsiders and forged tokens refused, persistence to HTML, and live edits becoming searchable.
- **Browser smoke test** (`e2e/smoke.mjs`, 33 checks, headless Chrome, three users at once): sign-in, formatting persisted, rename, import, search, sharing, read-only viewer, live typing seen by an editor and a viewer without reload, presence and named cursors, simultaneous typing converging, live rename, persistence, live revocation, export (downloaded Markdown file, print view, rendered PDF), and session expiry (redirect to sign-in and back).
- A clean `npm ci`, production build and pruned production run were checked from a fresh copy (the same steps as the Dockerfile).

## Deployment

The multi-stage Dockerfile builds the UI, builds and prunes the API, and runs on `node:22-slim` as a non-root user. On SIGTERM, pending edits are flushed to disk before exit. [render.yaml](render.yaml) targets Render's free plan, which supports WebSockets but has no persistent disk, so data resets on restart or redeploy and the demo data is re-seeded. Durable options: a Render disk at `/data`, any VM or Fly/Railway volume, or Postgres.

Scaling past one instance would need Hocuspocus's Redis extension so the instances share document updates. That is not needed at this scope.

## Deliberately not built

- Sign-up, password reset, SSO, and server-side session revocation
- Comments, suggestions, version history
- Images and tables inside documents (attachments cover sharing files alongside a document)
- Pagination on the documents list. Search uses SQL `LIKE`, which is fine at this size; FTS5 would be next.

## Next 2–4 hours

1. **Version history:** snapshot the Yjs state on store (or every N minutes) into a `document_versions` table, with a restore UI.
2. **Inline images** in documents (could reuse attachment storage), and one-click server-side PDF if users ask for it.
3. Sign-up and a server-side session table (logout everywhere, revocation).
4. Postgres plus a persistent deploy, and CI running the API tests and smoke test on each push.
