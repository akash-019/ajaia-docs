import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/database.js';
import { DEMO_PASSWORD } from '../src/db/seed.js';

/**
 * Real-time editing over real WebSockets: two users editing the same document,
 * with the server enforcing the same access rules as the REST API.
 */

let server: Server;
let app: ReturnType<typeof createApp>['app'];
let wsUrl: string;
let closeCollab: () => void;
const providers: HocuspocusProvider[] = [];
const sockets: HocuspocusProviderWebsocket[] = [];

beforeEach(async () => {
  const created = createApp({
    db: openDb(':memory:'),
    sessionSecret: 'test-secret',
    collab: { debounce: 20, maxDebounce: 50, sessionCheckMs: 100 },
  });
  app = created.app;
  server = createServer(app);
  created.collab.attach(server);
  closeCollab = created.collab.close;
  await new Promise<void>((resolve) => server.listen(0, resolve));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/collab`;
});

afterEach(async () => {
  providers.splice(0).forEach((p) => p.destroy());
  sockets.splice(0).forEach((s) => s.destroy());
  closeCollab();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function login(email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password: DEMO_PASSWORD }).expect(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return { agent, cookie };
}

interface Client {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  scope: Promise<string>;
  events: string[];
}

/** Connects like the browser does: same cookie, same document name. */
function connect(cookie: string, docId: string, epoch: string): Client {
  class CookieWebSocket extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { cookie } });
    }
  }
  const doc = new Y.Doc();
  const events: string[] = [];
  const websocketProvider = new HocuspocusProviderWebsocket({ url: wsUrl, WebSocketPolyfill: CookieWebSocket });
  let resolveScope!: (s: string) => void;
  const scope = new Promise<string>((r) => (resolveScope = r));
  const provider = new HocuspocusProvider({
    websocketProvider,
    name: docId,
    document: doc,
    token: epoch, // the document's createdAt
    onAuthenticated: ({ scope }) => resolveScope(scope),
    onAuthenticationFailed: () => resolveScope('denied'),
    onStateless: ({ payload }) => events.push(JSON.parse(payload).type),
  });
  provider.attach();
  providers.push(provider);
  sockets.push(websocketProvider);
  return { doc, provider, scope, events };
}

const nowS = () => Math.floor(Date.now() / 1000);
const sessionToken = (extra: Record<string, unknown> = {}, secret = 'test-secret') =>
  jwt.sign({ sub: 'u_alice', iss: 'ajaia-docs', sid: 'sid-live', auth_time: nowS(), iat: nowS(), exp: nowS() + 3600, ...extra }, secret);

const text = (doc: Y.Doc) => doc.getXmlFragment('default').toString();

function typeParagraph(doc: Y.Doc, value: string) {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(value)]);
  const fragment = doc.getXmlFragment('default');
  fragment.insert(fragment.length, [p]);
}

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('real-time collaboration', () => {
  it('syncs edits live between users, persists them, and enforces roles on the socket', async () => {
    const alice = await login('alice@ajaia.dev');
    const bob = await login('bob@ajaia.dev');
    const carol = await login('carol@ajaia.dev');

    const { body: doc } = await alice.agent.post('/api/documents').send({ title: 'Live' }).expect(201);
    await alice.agent.post(`/api/documents/${doc.id}/shares`).send({ email: 'bob@ajaia.dev', role: 'editor' });
    await alice.agent.post(`/api/documents/${doc.id}/shares`).send({ email: 'carol@ajaia.dev', role: 'viewer' });

    const a = connect(alice.cookie, doc.id, doc.createdAt);
    const b = connect(bob.cookie, doc.id, doc.createdAt);
    const c = connect(carol.cookie, doc.id, doc.createdAt);
    expect(await a.scope).toBe('read-write');
    expect(await b.scope).toBe('read-write');
    expect(await c.scope).toBe('readonly');

    // Alice types; Bob and Carol see it without reloading. Then Bob types; Alice sees it.
    typeParagraph(a.doc, 'hello from alice');
    await until(() => text(b.doc).includes('hello from alice') && text(c.doc).includes('hello from alice'));
    typeParagraph(b.doc, 'hi from bob');
    await until(() => text(a.doc).includes('hi from bob'));

    // A viewer's local change is dropped by the server and never reaches others.
    typeParagraph(c.doc, 'carol sneaks an edit');
    await new Promise((r) => setTimeout(r, 300));
    expect(text(a.doc)).not.toContain('carol sneaks');

    // Edits are persisted as sanitized HTML for the REST API.
    await new Promise((r) => setTimeout(r, 200));
    const { body: saved } = await alice.agent.get(`/api/documents/${doc.id}`).expect(200);
    expect(saved.content).toBe('<p>hello from alice</p><p>hi from bob</p>');
    const { text: exported } = await bob.agent.get(`/api/documents/${doc.id}/export?format=md`).expect(200);
    expect(exported).toBe('hello from alice\n\nhi from bob\n');
    const { body: found } = await bob.agent.get('/api/documents?q=from%20alice').expect(200);
    expect(found.shared.map((d: { id: string }) => d.id)).toEqual([doc.id]);

    // Renames are pushed to open editors.
    await alice.agent.patch(`/api/documents/${doc.id}`).send({ title: 'Live 2' }).expect(200);
    await until(() => b.events.includes('title'));

    // Attachment changes are pushed to open editors so their lists refresh.
    await alice.agent.post(`/api/documents/${doc.id}/attachments`).attach('file', Buffer.from('x'), 'a.txt').expect(201);
    await until(() => b.events.includes('attachments') && c.events.includes('attachments'));

    // Revoking access takes effect on the open connection immediately.
    const bobId = (await bob.agent.get('/api/auth/me')).body.id;
    await alice.agent.delete(`/api/documents/${doc.id}/shares/${bobId}`).expect(204);
    await until(() => b.events.includes('revoked'));
    typeParagraph(b.doc, 'after revoke');
    await new Promise((r) => setTimeout(r, 300));
    expect(text(a.doc)).not.toContain('after revoke');

    // Someone with no access to a document cannot open it live.
    const { body: secret } = await alice.agent.post('/api/documents').send({ title: 'Secret' }).expect(201);
    expect(await connect(carol.cookie, secret.id, secret.createdAt).scope).toBe('denied'); // not shared with Carol
    expect(await connect(`ajaia_session=${sessionToken({}, 'wrong-secret')}`, secret.id, secret.createdAt).scope).toBe('denied');
  });

  it('upgrades a viewer to editor without reconnecting', async () => {
    const alice = await login('alice@ajaia.dev');
    const carol = await login('carol@ajaia.dev');
    const { body: doc } = await alice.agent.post('/api/documents').send({}).expect(201);
    await alice.agent.post(`/api/documents/${doc.id}/shares`).send({ email: 'carol@ajaia.dev', role: 'viewer' });

    const a = connect(alice.cookie, doc.id, doc.createdAt);
    const c = connect(carol.cookie, doc.id, doc.createdAt);
    expect(await c.scope).toBe('readonly');
    await a.scope;

    await alice.agent.post(`/api/documents/${doc.id}/shares`).send({ email: 'carol@ajaia.dev', role: 'editor' });
    await until(() => c.events.includes('access'));
    typeParagraph(c.doc, 'carol can edit now');
    await until(() => text(a.doc).includes('carol can edit now'));
  });

  it('seeds the live document from stored HTML (imports, seed data)', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body: doc } = await alice.agent
      .post('/api/documents/import')
      .attach('file', Buffer.from('# Title\n\n- one\n- two'), 'notes.md')
      .expect(201);
    const a = connect(alice.cookie, doc.id, doc.createdAt);
    await a.scope;
    await until(() => text(a.doc).includes('one'));
    expect(text(a.doc)).toContain('<heading level="1">Title</heading>');
    expect(text(a.doc)).toContain('<bulletlist>');
  });

  it('closes live connections when the session expires or signs out, and keeps active ones open', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body: doc } = await alice.agent.post('/api/documents').send({}).expect(201);
    const quiet = await alice.agent.post('/api/documents').send({}).expect(201);

    // A session that expires in ~2 seconds and sees no activity is disconnected.
    const idle = connect(`ajaia_session=${sessionToken({ sid: 'idle', exp: nowS() + 2 })}`, doc.id, doc.createdAt);
    expect(await idle.scope).toBe('read-write');

    // Same short expiry, but activity over HTTP renews the session, which also extends the socket.
    const activeCookie = `ajaia_session=${sessionToken({ sid: 'active', iat: nowS() - 600, exp: nowS() + 2 })}`;
    const active = connect(activeCookie, quiet.body.id, quiet.body.createdAt);
    expect(await active.scope).toBe('read-write');
    await request(app).get('/api/documents').set('Cookie', activeCookie).expect(200);

    await until(() => idle.events.includes('session-ended'), 5000);
    await new Promise((r) => setTimeout(r, 500));
    expect(active.events).not.toContain('session-ended');

    // Signing out closes that session's live connections (e.g. other tabs).
    const tab = connect(alice.cookie, doc.id, doc.createdAt);
    expect(await tab.scope).toBe('read-write');
    await alice.agent.post('/api/auth/logout').expect(204);
    await until(() => tab.events.includes('session-ended'));
  });

  it('refuses a tab holding a copy from before the document was re-created, so nothing merges', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body: doc } = await alice.agent.post('/api/documents').send({ title: 'Fresh' }).expect(201);

    // A tab that still holds content from an older instance of this document (e.g. before a
    // database reset) reconnects with that instance's stamp: refused before syncing anything.
    const stale = connect(alice.cookie, doc.id, '2020-01-01T00:00:00.000Z');
    typeParagraph(stale.doc, 'stale copy from before the reset');
    expect(await stale.scope).toBe('denied');

    const current = connect(alice.cookie, doc.id, doc.createdAt);
    expect(await current.scope).toBe('read-write');
    await new Promise((r) => setTimeout(r, 300));
    expect(text(current.doc)).not.toContain('stale copy');
    expect(await connect(alice.cookie, doc.id, 'session-cookie').scope).toBe('denied'); // tabs running older app code
  });
});

