// Browser smoke test: real Studio login/CSP and blocked renderer networking.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'rive-browser-security-')));
process.env.RIVE_MCP_WORKSPACE = workspace;
const { startStudio, stopStudio } = await import('../dist/studio.js');
const { createRiv } = await import('../dist/rivWriter.js');
const { RiveHost } = await import('../dist/riveHost.js');
const { PAGE_SCRIPT } = await import('../dist/pageScript.js');
const host = new RiveHost(PAGE_SCRIPT);
let page;
let trap;
try {
  const rivPath = join(workspace, 'preview.riv');
  writeFileSync(rivPath, createRiv({ artboard: { name: 'Security smoke', width: 100, height: 100 }, shapes: [] }).bytes);
  const studio = await startStudio({ rivPath, port: 18978 });
  // RiveHost launches the same sandboxed Chromium used for normal rendering.
  page = await host.getPage();
  let requests = 0;
  trap = createServer((req, res) => { requests++; res.end('must not be reachable'); });
  await new Promise(r => trap.listen(0, '127.0.0.1', r));
  const trapPort = trap.address().port;
  const blocked = await page.evaluate(async port => {
    try { await fetch(`http://127.0.0.1:${port}/secret`); return false; } catch { return true; }
  }, trapPort);
  assert.equal(blocked, true);
  assert.equal(requests, 0);
  console.log('PASS: renderer blocks outbound and localhost requests');
  const context = await page.context().browser().newContext();
  const ui = await context.newPage();
  const errors = [];
  ui.on('pageerror', e => errors.push(e.message));
  await ui.goto(studio.url);
  await ui.waitForFunction(() => location.hash === '' && document.querySelector('#status')?.tagName !== 'P');
  await ui.waitForFunction(() => document.querySelector('#status')?.textContent === 'ready', null, { timeout: 15000 });
  const state = await ui.evaluate(() => fetch('/state').then(r => r.json()));
  assert.equal(state.rivName, 'preview.riv');
  assert.equal(new URL(ui.url()).hash, '');
  assert.ok(!(await ui.evaluate(() => document.cookie)).includes('rive_session'));
  const changed = await ui.evaluate(() => fetch('/notes', { method: 'POST', body: JSON.stringify({ text: 'smoke check' }) }).then(r => r.status));
  assert.equal(changed, 200);
  assert.deepEqual(errors, []);
  console.log('PASS: Studio fragment login, HttpOnly cookie, CSP, rendering and same-origin edits');
  await context.close();
} finally {
  stopStudio();
  await host.close();
  if (trap) await new Promise(r => trap.close(r));
  rmSync(workspace, { recursive: true, force: true });
}
