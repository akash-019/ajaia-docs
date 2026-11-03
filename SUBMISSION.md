# Submission

## Links

- **Live app:** https://ajaia-docs-asjy.onrender.com
- **Walkthrough video:** _TODO_ (also in [VIDEO_URL.txt](VIDEO_URL.txt))
- **Time spent:** _TODO: hours_

> **Before you test the live app:** it runs on Render's free plan. That plan sleeps after about 15 minutes without traffic, so the first request after a pause can take about a minute, and **data resets whenever it restarts**. If a document you created is gone after a break, that's why. The demo accounts and the shared "Welcome to Ajaia Docs" document are always re-created. Everything persists normally when run locally (see [README.md](README.md)).

## Test accounts

All accounts use the password **`demo1234`**. These are the only accounts: there is no sign-up, so share documents using these emails.

| Email | Role on "Welcome to Ajaia Docs" |
| --- | --- |
| `alice@ajaia.dev` | Owner |
| `bob@ajaia.dev` | Can edit |
| `carol@ajaia.dev` | View only |

**To see live collaboration:** sign in as Alice in one window and as Bob in a private window, open the same document in both, and type.

## What is included

| Item | Location |
| --- | --- |
| Source: API (Express 5, TypeScript, SQLite, Hocuspocus/Yjs) | [ajaia-docs-api/](ajaia-docs-api/) |
| Source: UI (Angular 21, TipTap) | [ajaia-docs-ui/](ajaia-docs-ui/) |
| Setup and run instructions | [README.md](README.md) |
| Architecture note | [ARCHITECTURE.md](ARCHITECTURE.md) |
| AI workflow note | [AI_WORKFLOW.md](AI_WORKFLOW.md) |
| Walkthrough video URL | [VIDEO_URL.txt](VIDEO_URL.txt) |
| Automated tests: API, including real-WebSocket collaboration | [ajaia-docs-api/test/](ajaia-docs-api/test/) |
| Automated tests: browser smoke (36 checks) | [e2e/smoke.mjs](e2e/smoke.mjs) |
| Automated test: tab recovery after a server reset | [e2e/reset-recovery.mjs](e2e/reset-recovery.mjs) |
| Screenshots of the main flows | [docs/screenshots/](docs/screenshots/) |
| Deployment config | [Dockerfile](Dockerfile), [render.yaml](render.yaml) |

## Status

**Working end to end**

- Create, rename, edit, reopen and delete documents
- Bold, italic, underline, H1–H3, bulleted and numbered lists, quote, undo/redo, all persisted across reloads
- **Real-time co-editing:** live typing, named cursors, presence avatars, simultaneous edits merged, live rename, and offline edits synced on reconnect
- **Search** across titles and document text, limited to documents you can access, with highlighted snippets
- **File upload (.txt, .md, .docx; max 2 MB):** import as a new editable document, or insert a file's content at the cursor of an open document (it appears live for others). Clear errors for unsupported, corrupt or oversized files.
- **Attachments:** attach files to a document (PDF, images, Word, Excel, PowerPoint, TXT, MD, CSV, ZIP; up to 5 MB each, 10 per document). Everyone with access can download; the list updates live.
- Sharing by email with **Can edit** or **View only**, role changes and removals applied live to open sessions. Owned and shared documents are listed separately.
- Server-enforced permissions on REST and on the live socket
- **Password sign-in:** scrypt hashes, JWT session in an httpOnly cookie, lockout after repeated failures
- **Session timeout:** 8 hours idle (renewed while active), 7 days maximum. Expired sessions are sent to sign-in and back, and live connections close at expiry.
- **Export:** Markdown download, and PDF via print → "Save as PDF"
- Stretch items: real-time collaboration indicators, role-based sharing (editor vs. viewer), and export to Markdown/PDF

**Incomplete or simplified (deliberate)**

- No sign-up or password reset; accounts are seeded.
- Sessions are stateless JWTs, so a token can't be revoked server-side before it expires (at most 8 idle hours, 7 days total).
- Free-tier hosting has no persistent disk, so data resets on restart or redeploy and demo data is re-seeded. See [ARCHITECTURE.md](ARCHITECTURE.md#deployment).
- No version history or comments.
- PDF export goes through the browser's print dialog rather than a one-click download.

**Next 2–4 hours:** version history with restore, inline images, sign-up with server-side sessions, then Postgres and a persistent deploy with CI. Details are in [ARCHITECTURE.md](ARCHITECTURE.md#next-24-hours).
