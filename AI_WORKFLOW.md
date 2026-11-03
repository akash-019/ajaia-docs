# AI workflow note

## Tools used

- **Claude Code (Claude Opus) in VS Code** was the main tool: planning, scaffolding, writing code, running commands, and running the tests and a headless browser.
- **Angular CLI, npm, Vitest and headless Chrome (Puppeteer)** produced the checks that AI output was judged against.

## How I worked with it

I treated the AI as a fast pair programmer. I set the direction and the constraints, and I made every decision based on evidence: compiler output, test results, HTTP responses and screenshots, not the model's claims.

1. **Decompose first.** I pasted the brief and asked for a scoped plan before any code. The plan fixed the stack, the core flows, the deliberate cuts, and the riskiest parts (access control, data loss on concurrent saves, unsafe HTML from uploads).
2. **Steer early.** The first plan proposed React. I redirected it to **Angular**, and to a layout of two apps, **`ajaia-docs-ui`** and **`ajaia-docs-api`**, before much UI code existed, so the change was cheap.
3. **Backend first, proven by tests.** The API and its integration tests came before any UI, so the UI was built against behavior that was already verified.
4. **Verify in a real browser.** I had it write a headless-Chrome script for the full flows and reviewed the screenshots myself, looking for UX problems that unit tests can't show.
5. **Iterate on real use.** When I tried the app myself, I found that other users' changes only appeared after a refresh. I asked for live updates, password sign-in instead of the account picker, and document search. For each change I asked about the tradeoffs before accepting it (for example, JWT versus a signed cookie).

## Where AI materially sped things up

- Scaffolding the two apps, the Express routes, the zod schemas and the Angular pages: hours of typing became minutes.
- Library integration details: TipTap 3 in Angular without a wrapper library, mammoth/marked conversion, and multer limits.
- Real-time collaboration. It read the installed Hocuspocus v4 type definitions and source instead of relying on memory, which mattered because v4 changed the server integration API. It then wired Hocuspocus onto our own HTTP server so one port and one cookie cover REST and WebSocket.
- Writing the test suites, including the browser smoke test that also produced the screenshots.
- Fast diagnosis of environment failures (below), each one read from logs instead of guessed.

## What I changed or rejected

| AI output / first attempt | Problem | What we did |
| --- | --- | --- |
| React + Vite UI in the first plan | Not the stack I wanted | Switched to Angular 21 before the UI was built |
| `better-sqlite3` for storage | Its prebuilt binary needs glibc 2.33; it crashed on the dev machine and would be fragile to deploy | Moved to Node's built-in `node:sqlite`, with no native dependency |
| `npm install` crashed in the new Angular app (an npm bug) | First fix was a workaround: `.npmrc` with `legacy-peer-deps` | Later found the cause: unused test packages left over from the Angular scaffold (`vitest`, `jsdom`). Removed them and the workaround; clean installs now work without it. |
| Latest Angular (22) | Requires Node ≥ 22.22; local Node is 22.21 | Pinned Angular 21 rather than forcing a Node upgrade |
| TypeScript 7 installed by default | Too new to trust for the server build | Pinned TypeScript ~5.9 |
| Route guard calling `inject()` after `await` | Angular throws at runtime, because the injection context is gone after an await | Caught in review; injected before the await |
| Malformed JSON request → 500 | Wrong status, and a client error that looked like a server bug | Error handler respects body-parser's 4xx; regression test added |
| Rename: typing appended to "Untitled document" | Found by the browser test and confirmed in a screenshot. Real UX friction. | The title is now selected on focus, as in Google Docs |
| `<select [value]>` for share roles | Unreliable before the options render | Switched to `[selected]` on each option |
| Production cookie always `Secure` | Login silently fails if the production build is served over plain HTTP | Added a `COOKIE_SECURE=false` override, documented |
| Viewer status read "Saved 1:48 PM" | Misleading to someone who cannot save | Now reads "Last edited …" for viewers |
| Version check with a 409 conflict prompt (first design) | Correct, but other users' changes only appeared after a refresh. Not collaborative enough. | Replaced with Yjs CRDT co-editing. Kept the "server decides access" rule and moved it onto the socket. |
| Polling for changes (considered) | It would overwrite text while two people type and cause constant conflicts | Rejected in favor of a CRDT |
| Account picker with no password (first design) | Fine for a demo, but not a real login | Email and password with scrypt, the same error for unknown email and wrong password, and a lockout |
| Signed cookie holding the user id | I asked whether we should use JWT | Switched to a JWT (HS256, pinned algorithm, expiry) but **kept it in an httpOnly cookie** rather than localStorage, so page scripts can't read it and the WebSocket still authenticates automatically |
| Browser test "edits converge" failing | The test compared raw text, which included the *other* user's cursor label | Fixed the test (strip cursor widgets); the sync itself was correct |
| Session lasted a fixed 7 days, and the UI didn't react to expiry (my question: "is there any session time?") | Too long for an idle session, and expired users just saw errors | 8 hours idle (sliding) and 7 days absolute. A 401 sends the user to sign-in and back. Live sockets also enforce expiry, which was easy to miss because a WebSocket outlives the request that authenticated it. |
| Server-side PDF with headless Chrome (considered for export) | Heavy image, high memory and slow cold starts on free hosting | Browser print with a dedicated print stylesheet; Markdown is generated on the server |
| Default Markdown conversion | Dropped underline and produced loose, widely spaced lists | Custom rules: underline kept as `<u>` (re-imports cleanly), tight list items. A round-trip test protects this. |
| API routes mixed SQL, access checks and response shaping in one file | Harder to read and change as features grew | I asked for an MVC structure: models, views, controllers, services, routes. It was done as a refactor only, with no behavior change, and the existing 15 API tests and 27 browser checks passed unchanged before and after. |
| Search box showed two clear buttons | Chrome's built-in clear button plus ours | Hid the native one |
| Server: idle WebSocket timeouts | Hocuspocus closes connections it hasn't heard from | Server pings each socket and marks it alive on pong |

## How I verified correctness, UX and reliability

- **Correctness:** 15 API tests.
  - Sign-in: wrong password, lockout, and forged, expired, wrong-algorithm and `alg:none` tokens.
  - Session timeout: sliding renewal, the 7-day cap, and sockets closed on expiry or sign-out.
  - Access control across owner, editor, viewer and stranger, including removal.
  - Search scoping, validation and XSS sanitization.
  - Markdown export, including an export → re-import round trip.
  - **Collaboration over real WebSockets:** live sync, viewer edits dropped by the server, live removal and upgrade, outsiders refused, persistence and searchability.

  TypeScript strict mode on both apps.
- **End-to-end:** a 27-check headless-Chrome run with three users signed in at once.
  - Sign-in, create, format, reload persistence, rename, import, search, sharing and the read-only viewer.
  - Typing that appears live for others without a reload, named cursors, simultaneous typing that converges, live rename, live revocation, export (downloaded file, print view, rendered PDF), and session expiry.

  A .docx import, a broken .docx and an oversized file were checked by hand against the API.
- **UX:** I reviewed every screenshot ([docs/screenshots](docs/screenshots)), which is how the rename, "Saved" wording and double clear-button issues were found.
- **Shipping:** a clean `npm ci`, production build, pruned install and production run from a fresh copy, which are the same steps the Dockerfile runs. Prod-mode login, the seeded share and the viewer write block were confirmed over HTTP.

- **Production:** the Docker image couldn't be built locally (no access to the Docker daemon on this machine), so its steps were run individually first. The deployed app (https://ajaia-docs-asjy.onrender.com) was then checked over HTTPS:
  - sign-in, with the session cookie set `HttpOnly; Secure; SameSite=Lax`
  - search, export, and 401 for signed-out requests
  - two real clients editing live through Render's WebSocket proxy (about 300 ms to sync, viewer writes blocked)
  - a headless-browser pass with no JavaScript errors

  The live-editing check used a temporary document, deleted afterwards, so the demo data stayed clean.
