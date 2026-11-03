// Regression test: an open tab must not merge its old copy into a document that was re-created
// on the server (e.g. the database was reset by a redeploy). Starts its own API server from the
// production build (../ajaia-docs-api/dist), so build first: npm --prefix ../ajaia-docs-api run build
// Usage: CHROME_PATH=/usr/bin/google-chrome node reset-recovery.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const PORT = process.env.PORT ?? '3199';
const B = `http://localhost:${PORT}`;
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ajaia-reset-')), 'test.db');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const wipe = () => { for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true }); };
const startServer = () =>
  spawn('node', ['--disable-warning=ExperimentalWarning', 'dist/server.js'], {
    cwd: new URL('../ajaia-docs-api', import.meta.url).pathname,
    env: { ...process.env, PORT, DB_PATH: DB, SESSION_SECRET: 'reset-recovery-test-secret-0123456789abcdef' },
    stdio: 'ignore',
  });
async function welcomeMarkdown() {
  const r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'carol@ajaia.dev', password: 'demo1234' }) });
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  return (await fetch(`${B}/api/documents/welcome/export?format=md`, { headers: { cookie } })).text();
}
const copies = (md) => (md.match(/^# Welcome to Ajaia Docs/gm) || []).length;

const results = [];
const check = (name, ok) => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`);
let server = startServer();
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  await wait(2000);
  const page = await browser.newPage();
  await page.goto(`${B}/login`); await page.waitForSelector('.login-form');
  await page.type('input[type=email]', 'bob@ajaia.dev'); await page.type('input[type=password]', 'demo1234');
  await page.click('.login-form .btn-primary'); await page.waitForSelector('.page-head');
  await page.goto(`${B}/docs/welcome`); await page.waitForSelector('.doc-body h1', { visible: true });
  await wait(1500);

  // "Redeploy" with a fresh database while the tab stays open; the tab reconnects by itself.
  server.kill(); await wait(1000); wipe();
  server = startServer(); await wait(8000);

  check('document not duplicated after reset + reconnect', copies(await welcomeMarkdown()) === 1);
  check('tab shows a single copy', (await page.$$eval('.doc-body h1', (h) => h.length)) === 1);
  await page.click('.doc-body h1'); await page.keyboard.press('End'); await page.keyboard.type(' AFTER-RESET');
  await wait(2500);
  const md = await welcomeMarkdown();
  check('edits after recovery are saved', md.includes('AFTER-RESET') && copies(md) === 1);
} finally {
  await browser.close();
  server.kill();
}
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
