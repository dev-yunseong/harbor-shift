import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Docker } from '../src/docker.js';
import { Admission } from '../src/http.js';
import { Store } from '../src/store.js';
import { validate } from '../src/config.js';
const config = () => readFile(new URL('../examples/config.json', import.meta.url), 'utf8').then(JSON.parse);

test('configuration rejects typos, insecure transport, and invalid deadlines', async () => {
  const c = await config(); assert.equal(validate(c), c);
  assert.throws(() => validate({ ...c, typo: true }), /Unknown/);
  assert.throws(() => validate({ ...c, allowHttp: false }), /HTTP/);
  assert.throws(() => validate({ ...c, timing: { ...c.timing, drainMs: 0 } }), /drainMs/);
});
test('Docker create uses pinned image and explicit security/ownership flags without shell', async () => {
  const c = await config(), calls = [], image = `sha256:${'a'.repeat(64)}`;
  const d = new Docker(c, async (binary, args, opts) => { calls.push({ binary, args, opts }); return { stdout: '' }; });
  await d.prepare('green', image);
  const create = calls.find(x => x.args.includes('create'));
  assert.equal(create.args.at(-1), image); assert.ok(create.args.includes('harbor-shift.slot=green'));
  assert.equal(create.opts.shell, false); assert.ok(create.args.includes('no-new-privileges'));
});
test('Docker stop explicitly requests TERM with configured kill deadline', async () => {
  const c = await config(), calls = [];
  const d = new Docker(c, async (_, args) => { calls.push(args); return { stdout: '' }; });
  d.inspect = async () => ({ running: false }); await d.stop('blue');
  assert.deepEqual(calls[0].slice(2), ['container', 'stop', '--signal', 'SIGTERM', '--timeout', '30', 'demo-blue']);
});
test('Docker refuses foreign ownership before mutation', async () => {
  const c = await config(); const d = new Docker(c, async (_, args) => ({ stdout: args.includes('ls') ? 'demo-blue' : JSON.stringify([{ Config: { Labels: {} } }]) }));
  await assert.rejects(d.inspect('blue'), /ownership/);
});
test('exclusive filesystem lock and durable transaction block recovery guesses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harbor-test-'));
  try {
    const a = new Store(dir), b = new Store(dir), unlock = await a.lock();
    await assert.rejects(b.lock(), /Lock unavailable/); await a.begin({ old: 'blue' });
    assert.deepEqual(await b.pending(), { old: 'blue' }); await unlock();
    const release = await b.lock(); await b.complete(); await release(); assert.equal(await a.pending(), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('HTTP controller fixture checks CAS, readiness, drain and redacts errors', async () => {
  let active = 'blue', revision = '0', draining = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/route' && req.method === 'PUT') {
      const b = JSON.parse(body); if (b.expectedRevision !== revision) { res.writeHead(409); res.end('{}'); return; }
      active = b.active; revision = String(Number(revision) + 1);
    }
    if (req.url === '/drain') draining = true;
    const answer = req.url === '/route' ? { active, revision } : req.url === '/ready' ? { ready: true } : { draining, sessions: 0 };
    res.end(JSON.stringify(answer));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const c = await config(), url = `http://127.0.0.1:${server.address().port}`;
    c.controller = url; c.slots.blue.url = url;
    const a = new Admission(c, 'fixture-token'); assert.equal((await a.route()).active, 'blue');
    assert.equal((await a.switchTo('green', '0')).active, 'green');
    await assert.rejects(a.switchTo('blue', '0'), /redacted/);
    assert.equal(await a.ready('blue', 99.8), true); await a.drain('blue'); assert.equal(await a.sessions('blue'), 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
