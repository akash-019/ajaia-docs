import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { Hocuspocus } from '@hocuspocus/server';
import { generateHTML, generateJSON } from '@tiptap/html';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { canEdit, getRole, type Role } from './access.js';
import { sessionFromCookieHeader, type Session } from './auth.js';
import type { Db } from './db.js';
import { editorExtensions, editorSchema, YJS_FIELD } from './editor-schema.js';
import { sanitizeContent, toPlainText } from './sanitize.js';

export const COLLAB_PATH = '/api/collab';
const PING_INTERVAL_MS = 15_000;

interface CollabContext {
  userId: string;
  sid: string;
  /** Unix seconds; the connection is closed once its session expires. */
  expiresAt: number;
}

/** Messages pushed to connected editors over the collaboration socket. */
export type CollabEvent =
  | { type: 'title'; title: string }
  | { type: 'access'; role: Role }
  | { type: 'revoked' }
  | { type: 'deleted' }
  | { type: 'session-ended' };

export interface CollabOptions {
  /** Delay before persisting after the last change (ms). */
  debounce?: number;
  maxDebounce?: number;
  /** How often to close connections whose session has expired (ms). */
  sessionCheckMs?: number;
}

/**
 * Real-time co-editing. Each document is a Yjs CRDT synced over WebSocket by
 * Hocuspocus, so concurrent edits merge instead of conflicting. Access is checked
 * on connect with the same session cookie and rules as the REST API: viewers get a
 * read-only connection (their updates are dropped server-side) and strangers are refused.
 *
 * Persistence: the Yjs state is stored as a blob (for lossless sync), and a
 * sanitized HTML rendering is stored alongside it for the REST API and listings.
 */
export function createCollab(db: Db, sessionSecret: string, options: CollabOptions = {}) {
  const loadRow = db.prepare('SELECT content, ydoc FROM documents WHERE id = ?');
  const saveState = db.prepare('UPDATE documents SET ydoc = ? WHERE id = ?');
  const storeRow = db.prepare(
    `UPDATE documents SET ydoc = ?, content = ?, search_text = ?, version = version + 1, updated_at = ? WHERE id = ?`,
  );

  const hocuspocus = new Hocuspocus<CollabContext>({
    quiet: true,
    debounce: options.debounce ?? 1000,
    maxDebounce: options.maxDebounce ?? 5000,

    async onAuthenticate({ documentName, requestHeaders, connectionConfig }) {
      const session = sessionFromCookieHeader(requestHeaders.get('cookie'), sessionSecret);
      const role = session ? getRole(db, documentName, session.userId) : null;
      if (!session || !role) throw new Error('Not allowed');
      connectionConfig.readOnly = !canEdit(role);
      return { userId: session.userId, sid: session.sid, expiresAt: session.expiresAt } satisfies CollabContext;
    },

    async onLoadDocument({ documentName, document }) {
      const row = loadRow.get(documentName) as { content: string; ydoc: Uint8Array | null } | undefined;
      if (!row) return document;
      if (row.ydoc) {
        Y.applyUpdate(document, row.ydoc);
      } else if (row.content) {
        // First live session for a document created by import, seed or an older build:
        // build the Yjs state from stored HTML once and persist it, so every client
        // starts from the same CRDT history.
        const seeded = prosemirrorJSONToYDoc(editorSchema, generateJSON(row.content, editorExtensions), YJS_FIELD);
        Y.applyUpdate(document, Y.encodeStateAsUpdate(seeded));
        saveState.run(Y.encodeStateAsUpdate(document), documentName);
      }
      return document;
    },

    async onStoreDocument({ documentName, document }) {
      const state = Y.encodeStateAsUpdate(document);
      let html: string;
      try {
        html = sanitizeContent(generateHTML(yDocToProsemirrorJSON(document, YJS_FIELD), editorExtensions));
      } catch (err) {
        // Content that does not fit the schema is never rendered; keep the last good HTML.
        console.error(`Could not render document ${documentName}`, err);
        saveState.run(state, documentName);
        return;
      }
      storeRow.run(state, html, toPlainText(html), new Date().toISOString(), documentName);
    },
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });
  const connectionsOf = (docId: string) => hocuspocus.documents.get(docId)?.getConnections() ?? [];
  const allConnections = () => [...hocuspocus.documents.values()].flatMap((d) => d.getConnections());
  const send = (conn: { sendStateless(p: string): void }, event: CollabEvent) => conn.sendStateless(JSON.stringify(event));

  // The socket outlives the HTTP request that authenticated it, so session expiry is
  // enforced here too: connections are closed once their session runs out.
  const endSession = (match: (ctx: CollabContext) => boolean) => {
    for (const conn of allConnections()) {
      if (conn.context && match(conn.context)) {
        send(conn, { type: 'session-ended' });
        conn.close();
      }
    }
  };
  const sweep = setInterval(
    () => endSession((ctx) => ctx.expiresAt * 1000 <= Date.now()),
    options.sessionCheckMs ?? 30_000,
  );
  sweep.unref();

  return {
    hocuspocus,

    /** Activity renewed a session over HTTP: keep its live connections open accordingly. */
    sessionRenewed(session: Session) {
      for (const conn of allConnections()) {
        if (conn.context?.sid === session.sid) conn.context.expiresAt = session.expiresAt;
      }
    },

    /** The session signed out: close its live connections (other tabs of the same browser). */
    sessionEnded(sid: string) {
      endSession((ctx) => ctx.sid === sid);
    },

    /** Accept WebSocket upgrades on COLLAB_PATH for the given HTTP server. */
    attach(server: HttpServer) {
      server.on('upgrade', (req: IncomingMessage, socket, head) => {
        if (!req.url?.startsWith(COLLAB_PATH)) return socket.destroy();
        wss.handleUpgrade(req, socket, head, (ws) => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value);
          }
          const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { headers });
          const conn = hocuspocus.handleConnection(ws, request);
          const ping = setInterval(() => ws.ping(), PING_INTERVAL_MS);
          ws.on('pong', () => conn.touch());
          ws.on('message', (data: Buffer) => conn.handleMessage(new Uint8Array(data)));
          ws.on('close', (code, reason) => {
            clearInterval(ping);
            conn.handleClose({ code, reason: reason.toString() } as CloseEvent);
          });
        });
      });
    },

    /** Latest content of a document that is open for live editing (may be newer than the stored copy). */
    liveHtml(docId: string): string | null {
      const doc = hocuspocus.documents.get(docId);
      if (!doc) return null;
      try {
        return sanitizeContent(generateHTML(yDocToProsemirrorJSON(doc, YJS_FIELD), editorExtensions));
      } catch {
        return null;
      }
    },

    /** Tell everyone with the document open about a rename. */
    titleChanged(docId: string, title: string) {
      for (const conn of connectionsOf(docId)) send(conn, { type: 'title', title });
    },

    /** Apply a share change to a user's open connections immediately. */
    accessChanged(docId: string, userId: string, role: Role | null) {
      for (const conn of connectionsOf(docId)) {
        if (conn.context?.userId !== userId) continue;
        if (role) {
          conn.readOnly = !canEdit(role);
          send(conn, { type: 'access', role });
        } else {
          send(conn, { type: 'revoked' });
          conn.close();
        }
      }
    },

    documentDeleted(docId: string) {
      for (const conn of connectionsOf(docId)) {
        send(conn, { type: 'deleted' });
        conn.close();
      }
    },

    /** Persist pending changes now (graceful shutdown). */
    flush() {
      hocuspocus.flushPendingStores();
    },

    /** Drop all live sockets (shutdown, tests). */
    close() {
      clearInterval(sweep);
      for (const ws of wss.clients) ws.terminate();
    },
  };
}

export type Collab = ReturnType<typeof createCollab>;
