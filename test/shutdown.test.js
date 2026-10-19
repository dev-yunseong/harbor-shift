import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ShutdownAdmission, validateShutdown, attachStdin } from '../src/shutdown.js';
import { Docker } from '../src/docker.js';
import { fixture } from './helpers.js';

test('exec hook uses argv on the owned target with bounded observation', async () => {
  const c = { dockerContext: 'default', slots: { blue: { name: 'owned-blue' } }, timing: { commandMs: 10000 } };
  let call;
  const d = new Docker(c, async (binary, argv, options) => { call = { binary, argv, options }; return { stdout: '' }; });
  d.inspect = async () => ({ running: true });
  await d.execHook('blue', ['/app/drain', 'literal;$(no-shell)'], 123);
  assert.deepEqual(call.argv, ['--context', 'default', 'container', 'exec', 'owned-blue', '/app/drain', 'literal;$(no-shell)']);
  assert.equal(call.options.shell, false); assert.equal(call.options.timeout, 123);
});
test('HTTP initiation and completion are separate and headers resolve from environment', async () => {
  process.env.HARBOR_TEST_HEADER = 'fixture-only'; const calls = [];
  const config = { slots: { blue: { name: 'blue', url: 'http://localhost:9999' } }, shutdown: {
    initiate: { type: 'http', path: '/drain', method: 'POST', timeoutMs: 100, headersEnv: { Authorization: 'HARBOR_TEST_HEADER' }, body: { mode: 'drain' } },
    completion: { type: 'http', path: '/status', timeoutMs: 100 }
  } };
  validateShutdown(config.shutdown);
  const adapter = new ShutdownAdmission({}, { inspect: async () => ({ running: true }) }, config, 'adapter', async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ draining: true, sessions: 4 }));
  });
  try {
    await adapter.drain('blue'); assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.Authorization, 'fixture-only');
    assert.equal(await adapter.sessions('blue'), 4); assert.equal(calls[1].options.method, 'GET');
  } finally { delete process.env.HARBOR_TEST_HEADER; }
});
test('HTTP failing or hanging hooks are redacted and bounded', async () => {
  const c = { slots: { blue: { name: 'blue', url: 'http://localhost' } }, shutdown: { initiate: { type: 'http', path: '/drain', method: 'POST', timeoutMs: 10 } } };
  const failed = new ShutdownAdmission({}, { inspect: async () => ({ running: true }) }, c, 'adapter', async () => new Response('secret-body', { status: 500 }));
  await assert.rejects(failed.drain('blue'), /details redacted/);
  const hanging = new ShutdownAdmission({}, { inspect: async () => ({ running: true }) }, c, 'adapter', (_, opts) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1000); opts.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('secret')); });
  }));
  await assert.rejects(hanging.drain('blue'), /details redacted/);
});
test('unsupported original stdin is rejected rather than using docker exec', async () => {
  const c = { dockerContext: 'default', slots: { blue: { name: 'owned-blue' } }, timing: { commandMs: 100 } };
  const d = new Docker(c, async () => ({ stdout: '[{"Config":{"OpenStdin":false}}]' }));
  d.inspect = async () => ({ running: true });
  await assert.rejects(d.stdinHook('blue', 'drain\n', 10), /OpenStdin/);
});
test('stdin attachment writes the original stream and observes a bounded timeout', async () => {
  let written, requestOptions;
  const requester = options => {
    requestOptions = options;
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {
      const socket = new EventEmitter(); socket.destroy = () => {}; socket.write = (data, cb) => { written = data; cb(); };
      queueMicrotask(() => req.emit('upgrade', { statusCode: 101 }, socket));
    }; return req;
  };
  await attachStdin('/var/run/docker.sock', 'owned-blue', 'drain\n', 100, requester);
  assert.equal(written, 'drain\n'); assert.match(requestOptions.path, /\/containers\/owned-blue\/attach/);
  await assert.rejects(attachStdin('/test', 'owned-blue', 'drain\n', 10, () => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {}; return req;
  }), /timed out/);
});
test('hook failure keeps old running unless force-stop was explicitly selected', async () => {
  for (const policy of ['keep-old', 'force-stop']) {
    const f = fixture({ admission: { drain: async () => { throw Error('failed hook'); } } });
    f.c.shutdown = { onFailure: policy };
    if (policy === 'keep-old') { await assert.rejects(f.deployer.run({ dryRun: false }), /failed hook/); assert.equal(f.state.blue.running, true); }
    else { assert.equal((await f.deployer.run({ dryRun: false })).forced, true); assert.equal(f.state.blue.running, false); }
  }
});
test('invalid hook shapes and unknown transports fail validation', () => {
  assert.throws(() => validateShutdown({ initiate: { type: 'shell', command: 'anything' } }), /Unknown/);
  assert.throws(() => validateShutdown({ initiate: { type: 'exec', argv: ['drain'], timeoutMs: 0 } }), /timeout/);
});
