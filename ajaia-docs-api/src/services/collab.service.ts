import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { Hocuspocus } from '@hocuspocus/server';
import { generateHTML, generateJSON } from '@tiptap/html';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { editorExtensions, editorSchema, YJS_FIELD } from '../lib/editor-schema.js';
import { sanitizeContent } from '../lib/sanitize.js';
import type { DocumentModel } from '../models/document.model.js';
import { canEdit, type AccessService, type Role } from './access.service.js';
import type { Session, SessionService } from './session.service.js';

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
  | { type: 'session-ended' }
  | { type: 'attachments' };

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
export interface CollabDeps {
  documents: DocumentModel;
  access: AccessService;
  sessions: SessionService;
}

export function createCollabService({ documents, access, sessions }: CollabDeps, options: CollabOptions = {}) {
  const renderHtml = (doc: Y.Doc) =>
    sanitizeContent(generateHTML(yDocToProsemirrorJSON(doc, YJS_FIELD), editorExtensions));

  const hocuspocus = new Hocuspocus<CollabContext>({
    quiet: true,
    debounce: options.debounce ?? 1000,
    maxDebounce: options.maxDebounce ?? 5000,

    async onAuthenticate({ documentName, requestHeaders, connectionConfig, token }) {
      const session = sessions.fromCookieHeader(requestHeaders.get('cookie'));
      const role = session ? access.roleOf(documentName, session.userId) : null;
      if (!session || !role) throw new Error('Not allowed');
      // The client must name the document instance it holds (its createdAt). If the server's
      // document was re-created (e.g. the database was reset on redeploy), a tab still holding
      // the old copy is refused before any of its state can merge into the new one.
      if (token !== documents.findById(documentName)?.createdAt) throw new Error('Stale document');
      connectionConfig.readOnly = !canEdit(role);
      return { userId: session.userId, sid: session.sid, expiresAt: session.expiresAt } satisfies CollabContext;
    },

    async onLoadDocument({ documentName, document }) {
      const row = documents.loadState(documentName);
      if (!row) return document;
      if (row.ydoc) {
        Y.applyUpdate(document, row.ydoc);
      } else if (row.content) {
        // First live session for a document created by import, seed or an older build:
        // build the Yjs state from stored HTML once and persist it, so every client
        // starts from the same CRDT history.
        const seeded = prosemirrorJSONToYDoc(editorSchema, generateJSON(row.content, editorExtensions), YJS_FIELD);
        Y.applyUpdate(document, Y.encodeStateAsUpdate(seeded));
        documents.saveState(documentName, Y.encodeStateAsUpdate(document));
      }
      return document;
    },

    async onStoreDocument({ documentName, document }) {
      const state = Y.encodeStateAsUpdate(document);
      let html: string;
      try {
        html = renderHtml(document);
      } catch (err) {
        // Content that does not fit the schema is never rendered; keep the last good HTML.
        console.error(`Could not render document ${documentName}`, err);
        documents.saveState(documentName, state);
        return;
      }
      documents.saveContent(documentName, state, html);
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
        return renderHtml(doc);
      } catch {
        return null;
      }
    },

    /** Tell everyone with the document open about a rename. */
    titleChanged(docId: string, title: string) {
      for (const conn of connectionsOf(docId)) send(conn, { type: 'title', title });
    },

    /** Tell everyone with the document open that its attachments changed. */
    attachmentsChanged(docId: string) {
      for (const conn of connectionsOf(docId)) send(conn, { type: 'attachments' });
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

export type CollabService = ReturnType<typeof createCollabService>;
