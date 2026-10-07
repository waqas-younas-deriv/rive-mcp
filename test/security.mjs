import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request, createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

await test('security regression suite', async (t) => {
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'rive-security-')));
const workspace = join(root, 'animations');
fs.mkdirSync(workspace);
process.env.RIVE_MCP_WORKSPACE = workspace;
const safe = await import('../dist/workspaceFs.js');
const { startStudio, stopStudio, takeStudioNotes } = await import('../dist/studio.js');
const { createRiv } = await import('../dist/rivWriter.js');
const { simpleGlob } = await import('../dist/batchRender.js');
const scene = { artboard: { name: 'Safe', width: 100, height: 100 }, shapes: [] };
const riv = join(workspace, 'test.riv');
fs.writeFileSync(riv, createRiv(scene).bytes);
fs.writeFileSync(join(root, 'secret.txt'), 'SECRET OUTSIDE WORKSPACE');
t.after(() => { stopStudio(); fs.rmSync(root, { recursive: true, force: true }); });

function http(port, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolveResult, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('error', reject);
      res.on('data', b => chunks.push(b));
      res.on('end', () => resolveResult({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

await t.test('filesystem confines reads and writes, including non-existent destinations', () => {
  safe.writeFileSync('normal.json', '{}');
  assert.equal(safe.readFileSync('normal.json', 'utf8'), '{}');
  for (const p of ['../secret.txt', join(root, 'secret.txt'), '../new/file.riv', '.env', '.git/config', 'nested/.claude/settings.json', 'node_modules/evil.js', 'image.png:stream', 'NUL', 'node_modules ']) {
    assert.throws(() => safe.readFileSync(p));
    assert.throws(() => safe.writeFileSync(p, 'bad'));
  }
  assert.equal(fs.readFileSync(join(root, 'secret.txt'), 'utf8'), 'SECRET OUTSIDE WORKSPACE');
});

await t.test('symlink, hardlink and symlink-parent escapes are rejected', () => {
  fs.symlinkSync(join(root, 'secret.txt'), join(workspace, 'link.txt'));
  fs.symlinkSync(root, join(workspace, 'linked-dir'), 'dir');
  fs.linkSync(join(root, 'secret.txt'), join(workspace, 'hard.txt'));
  for (const p of ['link.txt', 'linked-dir/new.txt', 'hard.txt']) {
    assert.throws(() => safe.readFileSync(p));
    assert.throws(() => safe.writeFileSync(p, 'bad'));
  }
});

await t.test('large files and glob traversal are bounded', () => {
  const fd = fs.openSync(join(workspace, 'large.riv'), 'w');
  fs.ftruncateSync(fd, safe.MAX_FILE_BYTES + 1); fs.closeSync(fd);
  assert.throws(() => safe.readFileSync('large.riv'), /64 MiB/);
  assert.throws(() => safe.writeFileSync('huge.riv', Buffer.alloc(safe.MAX_FILE_BYTES + 1)), /64 MiB/);
  assert.ok(simpleGlob(join(workspace, '*.riv'), workspace).includes(riv));
  assert.throws(() => simpleGlob('../**/*.txt', workspace), /outside/);
  assert.throws(() => simpleGlob('/**/*.txt', workspace), /outside/);
});

await t.test('MCP refuses to start without an explicit dedicated workspace', () => {
  const env = { ...process.env }; delete env.RIVE_MCP_WORKSPACE;
  const result = spawnSync(process.execPath, ['dist/index.js'], { cwd: repository, env, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set RIVE_MCP_WORKSPACE/);
});

await t.test('actual MCP tools enforce filesystem policy and disable configuration writes', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'security-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repository, 'dist/index.js')],
    env: { ...process.env, RIVE_MCP_WORKSPACE: workspace },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const calls = [
      ['riv_list', { dir: root }],
      ['riv_import_svg', { svgPath: join(root, 'secret.txt'), outSpec: join(workspace, 'out.json') }],
      ['riv_create', { outPath: riv, scene: { ...scene, fonts: [{ id: 'leak', path: join(root, 'secret.txt'), subset: false }] } }],
      ['riv_setup', { scope: 'user' }],
      ['riv_studio_notes', { port: 12345 }],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.ok(!JSON.stringify(result).includes('SECRET OUTSIDE WORKSPACE'), name);
    }
    const listed = await client.callTool({ name: 'riv_list', arguments: { dir: workspace } });
    // The deliberately oversized fixture is rejected before parsing by riv_list.
    assert.equal(listed.isError, true);
    const inspected = await client.callTool({ name: 'riv_lint', arguments: { path: riv } });
    assert.ok(!inspected.isError, JSON.stringify(inspected));
  } finally { await client.close(); }
});

// Reserve an available local port, then release it for Studio.
const reservation = createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const handle = await startStudio({ rivPath: riv, port });
const link = new URL(handle.url);
const token = link.hash.slice(1);
const headers = { Authorization: `Bearer ${token}` };

await t.test('Studio link uses loopback and a fragment credential', () => {
  assert.equal(link.hostname, '127.0.0.1');
  assert.equal(link.search, '');
  assert.match(token, /^[a-f0-9]{64}$/);
});

await t.test('all data and mutation routes reject unauthenticated requests', async () => {
  for (const path of ['/state', '/file.riv', '/chat', '/notes', '/tree', '/events', '/api/snapshots']) {
    assert.equal((await http(port, path)).status, 401, path);
  }
  for (const path of ['/edit', '/riv-restore', '/rebuild', '/notes', '/chat', '/api/snapshots']) {
    assert.equal((await http(port, path, { method: 'POST', body: '{}' })).status, 401, path);
  }
  const page = await http(port, '/');
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes(token));
  assert.ok(!page.body.includes(workspace));
  assert.equal((await http(port, '/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

await t.test('Host and Origin checks reject rebinding and cross-origin requests', async () => {
  assert.equal((await http(port, '/state', { headers: { ...headers, Host: 'attacker.example' } })).status, 403);
  assert.equal((await http(port, '/state', { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await http(port, '/state', { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await http(port, '//[', { headers })).status, 400);
  assert.equal((await http(port, '/state', { headers })).status, 200);
});

await t.test('session cookie works, but cookie-only cross-site edits do not', async () => {
  const session = await http(port, '/session', { method: 'POST', headers });
  assert.equal(session.status, 204);
  const cookie = session.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const cookieHeader = cookie.split(';')[0];
  assert.equal((await http(port, '/state', { headers: { Cookie: cookieHeader } })).status, 200);
  assert.equal((await http(port, '/notes', { method: 'POST', headers: { Cookie: cookieHeader }, body: '{"text":"bad"}' })).status, 403);
  assert.equal((await http(port, '/notes', { method: 'POST', headers: { Cookie: cookieHeader, Origin: link.origin }, body: '{"text":"make it blue"}' })).status, 200);
  assert.equal(takeStudioNotes(true, port)[0].text, 'make it blue');
  assert.equal(takeStudioNotes(false, port + 1), null);
  assert.equal(takeStudioNotes(false, port).length, 1);
  assert.equal(takeStudioNotes(false, port).length, 0);
});

await t.test('authenticated rebuild works and escaping font paths cannot disclose files', async () => {
  const valid = await http(port, '/rebuild', { method: 'POST', headers, body: JSON.stringify(scene) });
  assert.equal(valid.status, 200);
  const before = fs.readFileSync(riv);
  const malicious = { ...scene, fonts: [{ id: 'leak', path: join(root, 'secret.txt'), subset: false }] };
  const response = await http(port, '/rebuild', { method: 'POST', headers, body: JSON.stringify(malicious) });
  assert.equal(response.status, 400);
  assert.match(response.body, /outside/);
  assert.deepEqual(fs.readFileSync(riv), before);
  assert.ok(!(await http(port, '/file.riv', { headers })).body.includes('SECRET OUTSIDE WORKSPACE'));
  const bundledFont = await http(port, '/rebuild', { method: 'POST', headers, body: JSON.stringify({ ...scene, fonts: [{ id: 'inter' }] }) });
  assert.equal(bundledFont.status, 200, bundledFont.body);
});

await t.test('oversized bodies and excessive notes are rejected', async () => {
  const oversized = await http(port, '/notes', { method: 'POST', headers: { ...headers, 'Content-Length': String(16 * 1024 * 1024 + 1) } });
  assert.equal(oversized.status, 413);
  try {
    const streamed = await http(port, '/notes', { method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' }, body: 'x'.repeat(16 * 1024 * 1024 + 1) });
    assert.equal(streamed.status, 413);
  } catch (error) {
    // Node may close the socket while the oversized sender is still writing.
    assert.ok(['ECONNRESET', 'EPIPE'].includes(error.code), String(error));
  }
  assert.equal((await http(port, '/state', { headers })).status, 200);
  const longNote = await http(port, '/notes', { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(8001) }) });
  assert.equal(longNote.status, 400);
});

await t.test('private snapshots can be saved, restored and deleted', async () => {
  const post = (path, body) => http(port, path, { method: 'POST', headers, body: JSON.stringify(body) });
  const saved = await post('/api/snapshots', { name: 'safe' });
  assert.equal(saved.status, 200);
  const id = JSON.parse(saved.body).snapshots[0].id;
  assert.equal((await post('/api/snapshots/restore', { id })).status, 200);
  assert.equal((await post('/api/snapshots/delete', { id })).status, 200);
});

await t.test('restarting Studio invalidates the previous session', async () => {
  stopStudio();
  const next = await startStudio({ rivPath: riv, port });
  assert.notEqual(new URL(next.url).hash, link.hash);
  assert.equal((await http(port, '/state', { headers })).status, 401);
});

await t.test('occupied ports fail cleanly without claiming Studio started', async () => {
  stopStudio();
  const blocker = createServer();
  await new Promise(r => blocker.listen(port, '127.0.0.1', r));
  try { await assert.rejects(startStudio({ rivPath: riv, port }), /EADDRINUSE/); }
  finally { await new Promise(r => blocker.close(r)); }
});

});
