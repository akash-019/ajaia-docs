import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from '../src/auth.js';
import { DEMO_PASSWORD, openDb } from '../src/db.js';
import { sanitizeContent } from '../src/sanitize.js';

let app: ReturnType<typeof createApp>['app'];

beforeEach(() => {
  app = createApp({ db: openDb(':memory:'), sessionSecret: 'test-secret' }).app;
});

const nowS = () => Math.floor(Date.now() / 1000);
const claims = (extra: Record<string, unknown> = {}) => ({
  sub: 'u_alice',
  iss: 'ajaia-docs',
  sid: 'sid-1',
  auth_time: nowS(),
  iat: nowS(),
  exp: nowS() + 3600,
  ...extra,
});
const token = (extra: Record<string, unknown> = {}, secret = 'test-secret') => jwt.sign(claims(extra), secret);

async function login(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password: DEMO_PASSWORD }).expect(200);
  return agent;
}

describe('auth', () => {
  it('requires the right password and does not reveal which part was wrong', async () => {
    await request(app).get('/api/documents').expect(401);
    await request(app).get('/api/users').expect(401);
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@ajaia.dev', password: 'nope' })
      .expect(401);
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@ajaia.dev', password: 'nope' })
      .expect(401);
    expect(wrongPassword.body.error).toBe('Incorrect email or password');
    expect(unknownEmail.body.error).toBe(wrongPassword.body.error);
    await request(app).post('/api/auth/login').send({ email: 'alice@ajaia.dev' }).expect(400);
    await request(app).post('/api/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400);

    const alice = await login('alice@ajaia.dev');
    expect((await alice.get('/api/auth/me').expect(200)).body.email).toBe('alice@ajaia.dev');
    await alice.post('/api/auth/logout').expect(204);
    await alice.get('/api/auth/me').expect(401);
  });

  it('accepts only valid, unexpired session tokens signed by the server', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body: me } = await alice.get('/api/auth/me').expect(200);
    expect(me.expiresAt - nowS()).toBeGreaterThan(SESSION_IDLE_SECONDS - 60);

    const asAlice = (t: string) => request(app).get('/api/documents').set('Cookie', `ajaia_session=${t}`);
    await asAlice(token()).expect(200);
    await asAlice(token({}, 'someone-elses-secret')).expect(401);
    await asAlice(token({ exp: nowS() - 60 })).expect(401);
    await asAlice(jwt.sign(claims(), 'test-secret', { algorithm: 'HS512' })).expect(401);
    const { sid: _sid, ...noSid } = claims();
    await asAlice(jwt.sign(noSid, 'test-secret')).expect(401);
    const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.`;
    await asAlice(unsigned).expect(401);
  });

  it('renews the session while active, but never past 7 days from sign-in', async () => {
    const sessionCookie = (res: request.Response) =>
      ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((c) => c.startsWith('ajaia_session='));
    const decode = (cookie: string) => jwt.decode(cookie.split(';')[0].split('=')[1]) as Record<string, number | string>;

    // Fresh token: no renewal on every request.
    expect(sessionCookie(await request(app).get('/api/documents').set('Cookie', `ajaia_session=${token()}`))).toBeUndefined();

    // Token issued 10 minutes ago, expiring in 1 hour: activity slides expiry to 8 hours from now.
    const authTime = nowS() - 3600;
    const res = await request(app)
      .get('/api/documents')
      .set('Cookie', `ajaia_session=${token({ iat: nowS() - 600, exp: nowS() + 3600, auth_time: authTime })}`)
      .expect(200);
    const renewed = decode(sessionCookie(res)!);
    expect(renewed).toMatchObject({ sid: 'sid-1', auth_time: authTime, sub: 'u_alice' });
    expect(Number(renewed.exp) - nowS()).toBeGreaterThan(SESSION_IDLE_SECONDS - 60);

    // Near the absolute limit, renewal stops at 7 days after sign-in.
    const nearMax = nowS() - SESSION_MAX_SECONDS + 600;
    const capped = await request(app)
      .get('/api/documents')
      .set('Cookie', `ajaia_session=${token({ iat: nowS() - 600, exp: nowS() + 300, auth_time: nearMax })}`)
      .expect(200);
    expect(decode(sessionCookie(capped)!).exp).toBe(nearMax + SESSION_MAX_SECONDS);

    // Past the absolute limit the session is over, even if the token itself hasn't expired.
    await request(app)
      .get('/api/documents')
      .set('Cookie', `ajaia_session=${token({ auth_time: nowS() - SESSION_MAX_SECONDS - 1 })}`)
      .expect(401);
  });

  it('locks out repeated failed attempts', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/auth/login').send({ email: 'bob@ajaia.dev', password: `guess${i}` }).expect(401);
    }
    // Even the right password is refused while locked.
    await request(app).post('/api/auth/login').send({ email: 'bob@ajaia.dev', password: DEMO_PASSWORD }).expect(429);
  });
});

describe('search', () => {
  it('finds documents by title or text, only among documents the user can access', async () => {
    const alice = await login('alice@ajaia.dev');
    const bob = await login('bob@ajaia.dev');

    await alice
      .post('/api/documents/import')
      .attach('file', Buffer.from('# Roadmap\n\nWe will migrate billing to Stripe in Q3.'), 'roadmap.md')
      .expect(201);
    const { body: budget } = await alice.post('/api/documents').send({ title: 'Budget 100% final' }).expect(201);
    await bob.post('/api/documents').send({ title: "Bob's billing notes" }).expect(201);

    const { body: byText } = await alice.get('/api/documents?q=STRIPE').expect(200);
    expect(byText.owned).toHaveLength(1);
    expect(byText.owned[0]).toMatchObject({ title: 'roadmap' });
    expect(byText.owned[0].snippet).toContain('billing to Stripe');

    // Bob's own doc mentions billing but is not Alice's; Alice only sees hers.
    const { body: billing } = await alice.get('/api/documents?q=billing').expect(200);
    expect(billing.owned.map((d: { title: string }) => d.title)).toEqual(['roadmap']);
    expect(billing.shared).toHaveLength(0);

    // LIKE wildcards are matched literally.
    const { body: percent } = await alice.get('/api/documents?q=100%25').expect(200);
    expect(percent.owned.map((d: { id: string }) => d.id)).toEqual([budget.id]);
    expect((await alice.get('/api/documents?q=%25').expect(200)).body.owned).toHaveLength(1);

    // Shared documents are searchable by the people they are shared with.
    await alice.post(`/api/documents/${budget.id}/shares`).send({ email: 'bob@ajaia.dev', role: 'viewer' }).expect(201);
    const { body: bobSearch } = await bob.get('/api/documents?q=budget').expect(200);
    expect(bobSearch.shared).toMatchObject([{ id: budget.id, ownerName: 'Alice Owner' }]);
  });
});

describe('sharing and access control', () => {
  it('enforces owner / editor / viewer access end to end', async () => {
    const alice = await login('alice@ajaia.dev');
    const bob = await login('bob@ajaia.dev');
    const carol = await login('carol@ajaia.dev');

    const { body: doc } = await alice.post('/api/documents').send({ title: 'Plan' }).expect(201);
    expect(doc.role).toBe('owner');

    // Not shared yet: invisible to others (404, not 403).
    await bob.get(`/api/documents/${doc.id}`).expect(404);

    // Only the owner can share.
    await bob.post(`/api/documents/${doc.id}/shares`).send({ email: 'bob@ajaia.dev' }).expect(404);
    await alice.post(`/api/documents/${doc.id}/shares`).send({ email: 'bob@ajaia.dev', role: 'editor' }).expect(201);
    await alice.post(`/api/documents/${doc.id}/shares`).send({ email: 'carol@ajaia.dev', role: 'viewer' }).expect(201);
    await bob.post(`/api/documents/${doc.id}/shares`).send({ email: 'carol@ajaia.dev' }).expect(403);

    // Shared docs show up separately from owned ones.
    const { body: bobList } = await bob.get('/api/documents').expect(200);
    expect(bobList.owned).toHaveLength(0);
    expect(bobList.shared).toMatchObject([{ id: doc.id, role: 'editor', ownerName: 'Alice Owner' }]);

    // Editor can rename; viewer can read but not write or delete.
    await bob.patch(`/api/documents/${doc.id}`).send({ title: 'Plan v2' }).expect(200);
    const { body: carolView } = await carol.get(`/api/documents/${doc.id}`).expect(200);
    expect(carolView).toMatchObject({ role: 'viewer', title: 'Plan v2' });
    await carol.patch(`/api/documents/${doc.id}`).send({ title: 'x' }).expect(403);
    await bob.delete(`/api/documents/${doc.id}`).expect(403);

    // Revoking access hides the document again.
    const bobId = (await bob.get('/api/auth/me')).body.id;
    await alice.delete(`/api/documents/${doc.id}/shares/${bobId}`).expect(204);
    await bob.get(`/api/documents/${doc.id}`).expect(404);
  });
});

describe('validation and sanitization', () => {
  it('rejects bad input with readable 400s', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body: doc } = await alice.post('/api/documents').send({}).expect(201);
    expect(doc.title).toBe('Untitled document');

    await alice.patch(`/api/documents/${doc.id}`).send({ title: '   ' }).expect(400);
    await alice.patch(`/api/documents/${doc.id}`).send({}).expect(400);
    await alice
      .post('/api/documents')
      .set('content-type', 'application/json')
      .send('{bad json')
      .expect(400, { error: 'Malformed JSON body' });
  });

  it('strips unsafe HTML before anything is stored', () => {
    expect(
      sanitizeContent('<h2>Hi</h2><img src=x onerror="alert(1)"><p onclick="x()"><u>ok</u></p><a href="javascript:alert(1)">l</a>'),
    ).toBe('<h2>Hi</h2><p><u>ok</u></p><a>l</a>');
  });
});

describe('file import', () => {
  it('turns a markdown file into an editable document, keeping structure', async () => {
    const alice = await login('alice@ajaia.dev');
    const md = '# Launch notes\n\nSome **bold** text.\n\n- one\n- two\n\n<script>alert(1)</script>';
    const { body: doc } = await alice
      .post('/api/documents/import')
      .attach('file', Buffer.from(md), 'launch-notes.md')
      .expect(201);

    expect(doc.title).toBe('launch-notes');
    expect(doc.content).toContain('<h1>Launch notes</h1>');
    expect(doc.content).toContain('<strong>bold</strong>');
    expect(doc.content).toMatch(/<ul>\s*<li>one<\/li>/);
    expect(doc.content).not.toContain('script');
  });

  it('converts plain text paragraphs and rejects unsupported types', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body: doc } = await alice
      .post('/api/documents/import')
      .attach('file', Buffer.from('first line\nsecond <line>\n\nnew para'), 'notes.txt')
      .expect(201);
    expect(doc.content).toBe('<p>first line<br />second &lt;line&gt;</p><p>new para</p>');

    const { body: err } = await alice
      .post('/api/documents/import')
      .attach('file', Buffer.from('%PDF'), 'report.pdf')
      .expect(400);
    expect(err.error).toMatch(/Unsupported file type/);
  });
});

describe('export', () => {
  it('downloads Markdown that keeps structure and imports back to the same document', async () => {
    const alice = await login('alice@ajaia.dev');
    const carol = await login('carol@ajaia.dev');
    const bob = await login('bob@ajaia.dev');
    const source = '# Plan\n\nShip **three** things <u>on time</u> and *calmly*.\n\n- one\n- two\n\n1. build\n2. ship\n';
    const { body: doc } = await alice
      .post('/api/documents/import')
      .attach('file', Buffer.from(source), 'Q4: Plan.md')
      .expect(201);

    const res = await alice.get(`/api/documents/${doc.id}/export?format=md`).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/markdown/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Q4 Plan.md"');
    expect(res.text).toBe('# Plan\n\nShip **three** things <u>on time</u> and *calmly*.\n\n- one\n- two\n\n1. build\n2. ship\n');

    // Round trip: importing the export gives the same content.
    const { body: again } = await alice
      .post('/api/documents/import')
      .attach('file', Buffer.from(res.text), 'again.md')
      .expect(201);
    expect(again.content).toBe(doc.content);

    // Readers can export; people without access can't; only Markdown is offered.
    await alice.post(`/api/documents/${doc.id}/shares`).send({ email: 'carol@ajaia.dev', role: 'viewer' }).expect(201);
    await carol.get(`/api/documents/${doc.id}/export?format=md`).expect(200);
    await bob.get(`/api/documents/${doc.id}/export?format=md`).expect(404);
    await alice.get(`/api/documents/${doc.id}/export?format=docx`).expect(400);
    await request(app).get(`/api/documents/${doc.id}/export?format=md`).expect(401);
  });
});
