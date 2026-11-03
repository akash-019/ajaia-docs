import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Browser smoke test of the main flows against a running app.
// Usage: BASE=http://localhost:3000 CHROME_PATH=/usr/bin/google-chrome node smoke.mjs [screenshot-dir]
// Expects a fresh database (seeded users only).

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = path.resolve(process.argv[2] ?? 'screenshots');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ajaia-e2e-'));
fs.mkdirSync(SHOTS, { recursive: true });
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo1234';
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1360, height: 860 } });
const errors = [];

async function session(email) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (process.env.DEBUG) page.on('response', (r) => r.url().includes('/api/') && console.log(email, r.request().method(), r.status(), r.url().slice(21)));
  page.on('dialog', (d) => { console.log('dialog', d.type()); d.accept(); });
  page.on('pageerror', (e) => errors.push(`${email}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('409') && !m.text().includes('404') && errors.push(`${email} console: ${m.text()}`));
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.login-form');
  if (email === 'alice@ajaia.dev') {
    // Wrong password is refused with a generic message.
    await page.type('input[type=email]', email);
    await page.type('input[type=password]', 'wrong-password');
    await page.click('.login-form .btn-primary');
    await page.waitForSelector('.login-form .alert-error');
    check('wrong password refused', (await page.$eval('.alert-error', (e) => e.textContent)).includes('Incorrect email or password'));
    await page.screenshot({ path: `${SHOTS}/01-login.png` });
    await page.$eval('input[type=email]', (el) => (el.value = ''));
    await page.$eval('input[type=password]', (el) => (el.value = ''));
  }
  await page.type('input[type=email]', email);
  await page.type('input[type=password]', PASSWORD);
  await page.click('.login-form .btn-primary');
  await page.waitForSelector('.page-head');
  return page;
}
const waitSaved = (page) => page.waitForFunction(() => document.querySelector('.save-status')?.textContent.trim() === 'All changes saved', { timeout: 8000 });
const openDoc = async (page, url) => { await page.goto(url); await page.waitForSelector('.doc-body h1', { visible: true }); };
// Document text without other people's cursor labels (rendered inside the editor as widgets).
const bodyText = (page) =>
  page.$eval('.doc-body', (el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('.collaboration-carets__caret').forEach((c) => c.remove());
    return copy.textContent;
  });
const tool = (page, title) => page.click(`.tool[title^="${title}"]`);

// 1. Alice creates, renames, formats
const alice = await session('alice@ajaia.dev');
await alice.click('.btn-primary');
await alice.waitForSelector('.doc-body', { visible: true });
check('new doc opens editor', true);
const title = await alice.$('.title-input');
await title.click(); await new Promise((r) => setTimeout(r, 50));
await title.type('Q4 Launch Plan');
await alice.keyboard.press('Enter');
await waitSaved(alice);
await alice.click('.doc-body');
await tool(alice, 'Heading 1'); await alice.keyboard.type('Launch goals');
await alice.keyboard.press('Enter');
await alice.keyboard.type('We ship ');
await tool(alice, 'Bold'); await alice.keyboard.type('three'); await tool(alice, 'Bold');
await alice.keyboard.type(' things, ');
await tool(alice, 'Underline'); await alice.keyboard.type('on time'); await tool(alice, 'Underline');
await alice.keyboard.type(' and ');
await tool(alice, 'Italic'); await alice.keyboard.type('calmly'); await tool(alice, 'Italic');
await alice.keyboard.press('Enter');
await tool(alice, 'Bulleted list'); await alice.keyboard.type('Editor'); await alice.keyboard.press('Enter'); await alice.keyboard.type('Sharing');
await alice.keyboard.press('Enter'); await alice.keyboard.press('Enter');
await tool(alice, 'Numbered list'); await alice.keyboard.type('Build'); await alice.keyboard.press('Enter'); await alice.keyboard.type('Ship');
await waitSaved(alice);
const docUrl = alice.url();
await alice.screenshot({ path: `${SHOTS}/02-editor-formatting.png` });

// 2. Persistence after reload
await alice.reload();
await alice.waitForSelector('.doc-body h1');
const html = await alice.$eval('.doc-body', (el) => el.innerHTML);
check('formatting persists after reload', ['<h1>Launch goals', '<strong>three</strong>', '<u>on time</u>', '<em>calmly</em>', '<ul>', '<ol>'].every((s) => html.includes(s)));
await alice.waitForFunction(() => document.querySelector('.title-input').value !== '');
check('rename persists', (await alice.$eval('.title-input', (el) => el.value)) === 'Q4 Launch Plan');

// 2b. Export: Markdown download from the menu, and the print view used for "Save as PDF".
const cdp = await alice.createCDPSession();
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: TMP });
await alice.click('.menu > .btn');
await alice.waitForSelector('.menu-list button', { visible: true });
await alice.click('.menu-list button:first-child');
const mdFile = path.join(TMP, 'Q4 Launch Plan.md');
for (let i = 0; i < 50 && !fs.existsSync(mdFile); i++) await new Promise((r) => setTimeout(r, 100));
const md = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
check('export downloads Markdown', md.startsWith('# Launch goals') && md.includes('**three**') && md.includes('<u>on time</u>') && md.includes('- Editor') && md.includes('1. Build'));
await alice.emulateMediaType('print');
const printView = await alice.evaluate(() => ({
  toolbarHidden: getComputedStyle(document.querySelector('.toolbar')).display === 'none',
  headerHidden: getComputedStyle(document.querySelector('.app-header')).display === 'none',
  bodyVisible: getComputedStyle(document.querySelector('.doc-body')).display !== 'none',
}));
check('print view shows only the document', printView.toolbarHidden && printView.headerHidden && printView.bodyVisible);
await alice.pdf({ path: path.join(TMP, 'export.pdf'), format: 'A4' });
check('PDF renders', fs.statSync(path.join(TMP, 'export.pdf')).size > 5000);
await alice.screenshot({ path: `${SHOTS}/09-print-pdf-view.png` });
await alice.emulateMediaType(null);

// 3. Share with Bob (editor) and Carol (viewer)
await alice.click('.editor-top .btn-primary');
await alice.waitForSelector('.share-form');
await alice.type('.share-form input', 'bob@ajaia.dev');
await alice.click('.share-form .btn-primary');
await alice.waitForFunction(() => document.querySelectorAll('.people li').length === 2);
await alice.type('.share-form input', 'carol@ajaia.dev');
await alice.select('.share-form select', 'viewer');
await alice.click('.share-form .btn-primary');
try {
  await alice.waitForFunction(() => document.querySelectorAll('.people li').length === 3);
} catch (e) {
  console.log('Share state at failure:', JSON.stringify(await alice.evaluate(() => ({ input: document.querySelector('.share-form input').value, role: document.querySelector('.share-form select').value, people: [...document.querySelectorAll('.people li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()), error: document.querySelector('.share-panel .alert-error')?.textContent, busy: document.querySelector('.share-form .btn-primary').disabled }))));
  throw e;
}
await alice.type('.share-form input', 'nobody@ajaia.dev');
await alice.click('.share-form .btn-primary');
await alice.waitForSelector('.share-panel .alert-error');
check('share with unknown email shows error', (await alice.$eval('.share-panel .alert-error', (e) => e.textContent)).includes('No user'));
await alice.screenshot({ path: `${SHOTS}/03-share-panel.png` });

// 4. Import a markdown file
await alice.goto(`${BASE}/`);
await alice.waitForSelector('input[type=file]');
const mdPath = path.join(TMP, 'meeting-notes.md');
fs.writeFileSync(mdPath, '# Meeting notes\n\nDecisions made **today**:\n\n1. Use SQLite\n2. Ship Friday\n\n## Risks\n\n- Scope creep\n');
const input = await alice.$('input[type=file]');
await input.uploadFile(mdPath);
await alice.waitForSelector('.doc-body h2');
const imported = await alice.$eval('.doc-body', (el) => el.innerHTML);
check('markdown import -> editable doc', imported.includes('<h1>Meeting notes') && imported.includes('<ol>') && imported.includes('<strong>today</strong>'));
await alice.waitForFunction(() => document.querySelector('.title-input').value !== '');
check('import title from filename', (await alice.$eval('.title-input', (el) => el.value)) === 'meeting-notes');
// Regression: merely opening a document (this one ends in a list) must not count as an edit.
const importedId = alice.url().split('/docs/')[1];
await new Promise((r) => setTimeout(r, 3000));
check('opening a document does not edit it', (await alice.evaluate(async (id) => (await (await fetch(`/api/documents/${id}`)).json()).version, importedId)) === 1);
const pdf = path.join(TMP, 'bad.pdf'); fs.writeFileSync(pdf, '%PDF-1.4');
await alice.goto(`${BASE}/`); await alice.waitForSelector('input[type=file]');
await (await alice.$('input[type=file]')).uploadFile(pdf);
await alice.waitForSelector('.alert-error');
check('unsupported upload shows error', (await alice.$eval('.alert-error', (e) => e.textContent)).includes('Unsupported'));
await alice.goto(`${BASE}/`); await alice.waitForSelector('.doc-row');
await alice.screenshot({ path: `${SHOTS}/04-documents-owner.png` });

// Search matches document text, not just titles, and highlights the match.
await alice.type('.search input', 'scope creep');
// Generous timeout: with three browsers running, the machine can be slow. On failure, show what was on screen.
try {
  await alice.waitForFunction(() => document.querySelectorAll('.doc-row').length === 1 && document.querySelector('.snippet mark'), { timeout: 10000 });
} catch (e) {
  console.log('Search state at failure:', JSON.stringify(await alice.evaluate(() => ({ input: document.querySelector('.search input').value, rows: [...document.querySelectorAll('.doc-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()), empty: document.querySelector('.empty')?.textContent }))));
  throw e;
}
check('search box keeps exactly what was typed (spaces included)', (await alice.$eval('.search input', (e) => e.value)) === 'scope creep');
check('search finds text inside documents', (await alice.$eval('.doc-row .doc-title', (e) => e.textContent)).includes('meeting-notes'));
await alice.screenshot({ path: `${SHOTS}/05-search.png` });
await alice.$eval('.search input', (el) => (el.value = ''));
await alice.type('.search input', 'zzz-no-match');
await alice.waitForFunction(() => document.querySelector('.empty')?.textContent.includes('No documents match'), { timeout: 5000 });
check('search shows empty state', true);

// 5. Bob sees it under "Shared with me" and edits
const bob = await session('bob@ajaia.dev');
// The list loads after the page header, so wait for it rather than reading the page immediately.
await bob.waitForFunction(() => [...document.querySelectorAll('.doc-row')].some((r) => r.textContent.includes('Q4 Launch Plan') && r.textContent.includes('Can edit')), { timeout: 8000 });
check('bob sees doc under Shared with me', true);
await bob.screenshot({ path: `${SHOTS}/06-documents-shared.png` });
await bob.goto(docUrl);
await bob.waitForSelector('.toolbar');
await bob.waitForSelector('.doc-body p', { visible: true });
await bob.click('.doc-body p');
await bob.keyboard.press('End');
await bob.keyboard.type(' Bob was here.');
await waitSaved(bob);
check('editor can edit + save', true);

// 6. Carol is view-only
const carol = await session('carol@ajaia.dev');
await carol.goto(docUrl);
await carol.waitForSelector('.notice');
await carol.waitForSelector('.doc-body p', { visible: true });
const editable = await carol.$eval('.doc-body', (el) => el.getAttribute('contenteditable'));
check('viewer: no toolbar, read-only', !(await carol.$('.toolbar')) && editable === 'false');
check('viewer sees bob edit', (await carol.$eval('.doc-body', (el) => el.textContent)).includes('Bob was here'));
await carol.screenshot({ path: `${SHOTS}/07-viewer-readonly.png` });

// 7. Live co-editing: Alice, Bob and Carol have the doc open; nobody reloads.
await openDoc(alice, docUrl);
await openDoc(bob, docUrl);
await openDoc(carol, docUrl);
await alice.click('.doc-body h1'); await alice.keyboard.press('End'); await alice.keyboard.type(' (live)');
await bob.waitForFunction(() => document.querySelector('.doc-body h1')?.textContent.includes('(live)'), { timeout: 5000 });
check('editor sees typing live (no reload)', true);
await carol.waitForFunction(() => document.querySelector('.doc-body h1')?.textContent.includes('(live)'), { timeout: 5000 });
check('viewer sees typing live (no reload)', true);
await bob.waitForSelector('.avatar-peer[title^="Alice"]', { timeout: 5000 });
await bob.waitForFunction(() => [...document.querySelectorAll('.collaboration-carets__label')].some((l) => l.textContent.includes('Alice')), { timeout: 5000 });
check('presence avatar + named cursor shown', true);

// Both type at the same moment in different places: edits merge, nobody is blocked.
await alice.click('.doc-body ol li:last-child'); await alice.keyboard.press('End');
await bob.click('.doc-body ul li:last-child'); await bob.keyboard.press('End');
await Promise.all([alice.keyboard.type(' +alice', { delay: 15 }), bob.keyboard.type(' +bob', { delay: 15 })]);
await waitSaved(alice); await waitSaved(bob);
await alice.waitForFunction(() => document.querySelector('.doc-body').textContent.includes('+bob'), { timeout: 5000 });
await bob.waitForFunction(() => document.querySelector('.doc-body').textContent.includes('+alice'), { timeout: 5000 });
check('simultaneous edits converge', (await bodyText(alice)) === (await bodyText(bob)));
await bob.screenshot({ path: `${SHOTS}/08-live-collaboration.png` });

// Insert a file into the open document: content lands at the cursor and others see it live.
check('insert button states supported types', (await alice.$eval('.tool-insert', (e) => e.textContent)).includes('.txt, .md, .docx'));
await alice.click('.doc-body ol li:last-child');
await alice.keyboard.down('Control'); await alice.keyboard.press('End'); await alice.keyboard.up('Control');
const appendix = path.join(TMP, 'appendix.md');
fs.writeFileSync(appendix, '## Appendix\n\n- inserted from a file\n');
await (await alice.$('.toolbar input[type=file]')).uploadFile(appendix);
await bob.waitForFunction(() => [...document.querySelectorAll('.doc-body h2')].some((h) => h.textContent.includes('Appendix')), { timeout: 8000 });
check('insert file into open document, others see it live', (await bodyText(bob)).includes('inserted from a file'));
await alice.waitForSelector('.alert-info', { timeout: 5000 });
await bob.screenshot({ path: `${SHOTS}/10-insert-file-live.png` });

// Attachments: Alice attaches a file; Bob's list updates live and he can download it; Carol can only download.
const png = path.join(TMP, 'diagram.png');
fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
await alice.click('.editor-top button::-p-text(Attachments)');
await alice.waitForSelector('.attach-upload input[type=file]');
check('attachment limits shown in panel', (await alice.$eval('app-attachments-panel', (e) => e.textContent)).includes('up to 5 MB each'));
await (await alice.$('.attach-upload input[type=file]')).uploadFile(png);
await bob.waitForFunction(() => [...document.querySelectorAll('.editor-top .btn')].some((b) => b.textContent.includes('Attachments (1)')), { timeout: 8000 });
check('attachment count updates live for others', true);
await bob.click('.editor-top button::-p-text(Attachments)');
await bob.waitForSelector('.attach-name');
const dl = await bob.evaluate(async () => {
  const href = document.querySelector('.attach-name').getAttribute('href');
  const r = await fetch(href);
  return { status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength };
});
check('editor can download attachment', dl.status === 200 && dl.type === 'image/png' && dl.size > 50);
await bob.screenshot({ path: `${SHOTS}/11-attachments.png` });
await carol.click('.editor-top button::-p-text(Attachments)');
await carol.waitForSelector('.attach-name');
check('viewer sees attachments read-only', !(await carol.$('.attach-upload')) && !(await carol.$('.attach-list .btn')));

// Regression: upgrading a viewer while they have the document open (it ends in a list) — their edits must reach others.
const docId = docUrl.split('/docs/')[1];
const setCarolRole = (role) => alice.evaluate((id, r) => fetch(`/api/documents/${id}/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'carol@ajaia.dev', role: r }) }), docId, role);
await setCarolRole('editor');
await carol.waitForSelector('.toolbar', { timeout: 8000 });
await carol.waitForFunction(() => document.querySelector('.save-status')?.textContent.includes('All changes saved'), { timeout: 8000 });
await carol.click('.doc-body h1'); await carol.keyboard.press('End'); await carol.keyboard.type(' (carol)');
await alice.waitForFunction(() => document.querySelector('.doc-body h1').textContent.includes('(carol)'), { timeout: 8000 });
check('viewer upgraded live can edit, others receive it', true);
await setCarolRole('viewer');
await carol.waitForFunction(() => !document.querySelector('.toolbar') && document.querySelector('.doc-body')?.getAttribute('contenteditable') === 'false', { timeout: 8000 });
check('editor downgraded live to read-only', true);

// Rename shows up for others live.
const t = await alice.$('.title-input'); await t.click(); await new Promise((r) => setTimeout(r, 50));
await t.type('Q4 Launch Plan (final)'); await alice.keyboard.press('Enter');
await bob.waitForFunction(() => document.querySelector('.title-input').value === 'Q4 Launch Plan (final)', { timeout: 5000 });
check('rename appears live for others', true);

// Persisted: a fresh load shows the merged content.
await openDoc(carol, docUrl);
check('merged content persisted', (await bodyText(carol)).includes('+alice') && (await bodyText(carol)).includes('+bob'));

// 8. Revoking Bob while he has the doc open ends his session immediately.
await alice.click('.editor-top .btn-primary'); await alice.waitForSelector('.people li:nth-child(2)');
const removeBtns = await alice.$$('.people .btn-ghost');
await removeBtns[0].click();
await alice.waitForFunction(() => document.querySelectorAll('.people li').length === 2);
await bob.waitForSelector('.alert-error', { visible: true, timeout: 5000 });
check('revoked editor is kicked live', (await bob.$eval('.alert-error', (e) => e.textContent)).includes('removed your access'));
await bob.reload();
await bob.waitForSelector('.alert-error', { visible: true });
check('revoked user cannot reopen', (await bob.$eval('.alert-error', (e) => e.textContent)).includes('not been shared'));

// 9. Session expiry: the session disappears mid-use; the next action leads to sign-in and back.
await carol.goto(`${BASE}/`); await carol.waitForSelector('.search input');
const [sessionCookie] = (await carol.cookies()).filter((c) => c.name === 'ajaia_session');
await carol.deleteCookie(sessionCookie);
await carol.type('.search input', 'plan');
await carol.waitForSelector('.login .alert-info', { timeout: 5000 });
check('expired session goes to sign-in with notice', carol.url().includes('reason=expired'));
await carol.type('input[type=email]', 'carol@ajaia.dev');
await carol.type('input[type=password]', PASSWORD);
await carol.click('.login-form .btn-primary');
await carol.waitForSelector('.page-head');
check('signing in again returns to the same page', new URL(carol.url()).pathname === '/');

console.log(results.join('\n'));
// 401 (session probe before login) and 400 (the rejected .pdf) are expected.
const unexpected = errors.filter((e) => !/status of (401|400)/.test(e));
console.log(unexpected.length ? `Unexpected JS errors:\n${unexpected.join('\n')}` : 'No unexpected JS errors');
await browser.close();
process.exit(results.some((r) => r.startsWith('FAIL')) || unexpected.length ? 1 : 0);
