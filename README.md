# Ajaia Docs

A lightweight collaborative document editor. Create, format, import, search and share documents, and edit them together in real time. Ownership and view/edit access are enforced by the server.

- **Live app:** https://ajaia-docs-asjy.onrender.com
- **Walkthrough video:** see [VIDEO_URL.txt](VIDEO_URL.txt)
- **Architecture and tradeoffs:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **AI workflow note:** [AI_WORKFLOW.md](AI_WORKFLOW.md)
- **What is included / status:** [SUBMISSION.md](SUBMISSION.md)

## Demo accounts

All three accounts use the password **`demo1234`**. These are the only accounts: there is no sign-up (a deliberate scope cut), so share documents using these emails.

| Account | Email | Use it to see |
| --- | --- | --- |
| Alice Owner | `alice@ajaia.dev` | Owner view: share, change access, delete |
| Bob Editor | `bob@ajaia.dev` | A document shared with **edit** access |
| Carol Viewer | `carol@ajaia.dev` | A document shared **view only** |

On first boot the app creates a **"Welcome to Ajaia Docs"** document owned by Alice and shared with Bob (edit) and Carol (view).

**Best demo:** open the welcome document as Alice in one browser window and as Bob in a private window, side by side, then type in either one.

## Features

| Area | What works |
| --- | --- |
| Documents | Create, rename (click the title), edit, delete (owner), reopen |
| Formatting | Bold, italic, underline, H1–H3, bulleted and numbered lists, quotes, undo/redo |
| **Real-time co-editing** | Everyone with the document open sees changes as they are typed, with other people's named cursors and avatars. Simultaneous edits merge (Yjs CRDT) instead of overwriting each other. A rename reaches everyone live. If the connection drops, edits are kept and sync on reconnect. |
| Search | Searches titles **and document text** across your own documents and those shared with you, with highlighted matches and a snippet of the surrounding text |
| Export | **Markdown** download (headings, lists, bold/italic/links kept; underline kept as `<u>`, which imports back unchanged) and **PDF** via the browser's print dialog ("Save as PDF"), with a print layout that shows only the document. Anyone who can open a document can export it. |
| File import | Upload **.txt, .md or .docx** (max 2 MB). It becomes a new editable document; headings, lists and bold/italic are kept. Images and complex Word layout are dropped. |
| Sharing | Owner shares by email as **Can edit** or **View only**, changes the role or removes access. **My documents** and **Shared with me** are listed separately. Access changes reach open editors immediately: a viewer upgraded to editor gets the toolbar, and a removed user is disconnected. |
| Access control | Enforced by the API and the live socket. Viewers' edits are dropped by the server, only the owner can share or delete, and anyone without access gets a 404. |
| Sign-in | Email + password (scrypt-hashed). The session is a JWT in an httpOnly cookie. Repeated failed attempts are locked out for 15 minutes. |
| Session timeout | You stay signed in while active. The session ends after **8 hours of inactivity**, and always **7 days** after sign-in. Once it expires, the next action (or a timer, if the tab is idle) takes you to sign-in with a notice and then back to the same page. Open live editing connections close at expiry too, and signing out closes them in your other tabs. |
| Persistence | SQLite stores the Yjs document state plus a sanitized HTML copy, so formatting survives reloads exactly. |

## Run locally

**Requires Node.js ≥ 22.13** (uses Node's built-in `node:sqlite`; tested on 22.21). No database server or paid service needed.

```bash
npm run install:all     # installs ajaia-docs-api and ajaia-docs-ui
npm run dev             # API on :3000 (auto-reload) + Angular on :4200 (proxies /api, including WebSockets)
```

Open http://localhost:4200 and sign in with a demo account.

To run it the production way (one server for UI, API and WebSockets):

```bash
npm run build
npm start               # http://localhost:3000
```

Data is written to `ajaia-docs-api/data/ajaia-docs.db`. Delete that file to reset.

### Tests

```bash
npm test                # API tests (Vitest + Supertest + real WebSocket clients, in-memory SQLite)
```

These cover:

- sign-in: wrong password, unknown email, lockout, and forged, expired, wrong-algorithm and `alg:none` JWTs
- session timeout: the idle timeout slides with activity but is capped at 7 days, and live connections close on expiry or sign-out unless activity has renewed the session
- the owner/editor/viewer access lifecycle, including removing access
- search, including access scoping and literal `%`/`_`
- sanitization, import, and Markdown export (including export → re-import giving the same document)
- **live collaboration over real sockets:** edits sync between users, the server drops viewer edits, removed access takes effect live, a viewer can be upgraded live, outsiders are refused, and live edits are persisted and searchable

There is also a headless-Chrome smoke test of the full UI (27 checks, including two users typing at once, export and session expiry). It needs a running app with a fresh database and a local Chrome:

```bash
cd e2e && npm install
BASE=http://localhost:3000 CHROME_PATH=/usr/bin/google-chrome npm run smoke   # also writes docs/screenshots/
```

### Configuration

Settings come from environment variables. For local runs, put them in `ajaia-docs-api/.env`; it's loaded at startup and is not committed:

```bash
cp ajaia-docs-api/.env.example ajaia-docs-api/.env   # then set SESSION_SECRET
```

On a host (Render, Docker), set real environment variables instead. `render.yaml` generates `SESSION_SECRET` for you.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `SESSION_SECRET` | dev value | Signs session JWTs. **Required in production** (random, 32+ characters): the server refuses to start without it. |
| `SESSION_IDLE_HOURS` | `8` | Sign out after this long without activity |
| `SESSION_MAX_DAYS` | `7` | Sign out this long after sign-in, even if active |
| `DB_PATH` | `data/ajaia-docs.db` | SQLite file |
| `SEED_DEMO_DOCS` | `true` | Create the welcome document on an empty database |
| `COOKIE_SECURE` | `true` in production | Set to `false` only when serving a production build over plain HTTP |
| `STATIC_DIR` | built Angular app | Folder of UI files served by the API |

## Deploy

The [Dockerfile](Dockerfile) builds one image that serves the UI, the REST API and the collaboration WebSocket from the same origin. There is no CORS setup, and cookies stay same-site.

**Render (free):** push this folder to a Git repo, then in Render choose **New → Blueprint** and pick the repo. [render.yaml](render.yaml) configures the web service, health check and a generated `SESSION_SECRET`. Render supports WebSockets on web services.

> Render's free plan has no persistent disk. Data lasts until the instance restarts or redeploys (for example after idling), and then the demo accounts and welcome document are re-seeded. For durable data, attach a disk at `/data` (paid plan) or run the image on any host with a volume. See [ARCHITECTURE.md](ARCHITECTURE.md#deployment).

## Project layout

```
ajaia-docs-api/   Express 5 + TypeScript API (MVC), SQLite, Hocuspocus (Yjs) collaboration server
  src/app.ts                composition root: models → services → controllers → routes
  src/routes/               URL → middleware → controller (auth, documents + shares)
  src/controllers/          C: read/validate the request, call models/services, send a view
  src/models/               M: all SQL (users, documents, shares)
  src/views/                V: response shapes (document, user, share)
  src/services/             access rules, JWT sessions, login limiter, live editing, import/export
  src/middleware/           auth (session + renewal), upload, errors
  src/validators/           zod request schemas
  src/db/                   schema + migrations, demo seed
  src/lib/                  sanitize, passwords, editor schema, HTTP error
  test/                     REST + real-WebSocket collaboration tests
ajaia-docs-ui/    Angular 21 (standalone components, signals, zoneless) + TipTap editor
  src/app/pages/            sign-in, documents list + search, editor, share panel
e2e/              headless-Chrome smoke test
docs/screenshots/ screenshots of the main flows
```
