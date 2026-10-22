import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProxyEnv } from '../src/proxy-env.js';
import { ShutdownAdmission } from '../src/shutdown.js';
import { Deployer } from '../src/deploy.js';
import { fixture } from './helpers.js';
const env = { HARBOR_ENABLED: 'true', HARBOR_GROUP: 'env-web', HARBOR_IMAGE: 'example/app:stable', HARBOR_NETWORK: 'test-net' };

test('environment config selects Docker shutdown with one-hour drain and bounded stop grace', () => {
  const c = loadProxyEnv(env);
  assert.equal(c.image, env.HARBOR_IMAGE);
  assert.equal(c.slots.blue.name, 'env-web-blue');
  assert.deepEqual(c.shutdown, { completion: { type: 'proxy' }, onFailure: 'keep-old' });
  assert.equal(c.timing.drainMs, 3600000);
  assert.equal(c.timing.stopSeconds, 120);
  assert.equal(c.timing.commandMs, 150000);
  assert.equal(loadProxyEnv({ ...env, HARBOR_STOP_SECONDS: '600' }).timing.commandMs, 630000);
});

test('REST config separates acknowledgement from process-exit or status completion', () => {
  const rest = { ...env, HARBOR_SHUTDOWN_MODE: 'http', HARBOR_HTTP_PATH: '/shutdown', HARBOR_HTTP_AUTHORIZATION: 'Bearer fixture-secret' };
  const c = loadProxyEnv(rest);
  assert.equal(c.shutdown.completion.type, 'exit');
  assert.deepEqual(c.shutdown.initiate.headersEnv, { Authorization: 'HARBOR_HTTP_AUTHORIZATION' });
  assert.ok(!JSON.stringify(c).includes('fixture-secret'));
  const status = loadProxyEnv({ ...rest, HARBOR_COMPLETION: 'http', HARBOR_HTTP_STATUS_PATH: '/status', HARBOR_HTTP_URL: 'http://{slot}:9090' });
  assert.equal(status.shutdown.completion.path, '/status');
  assert.equal(status.shutdown.initiate.url, 'http://{slot}:9090');
});

test('environment validation rejects unsafe or ambiguous shutdown settings before deployment', () => {
  for (const extra of [
    { HARBOR_ENABLED: 'false' }, { HARBOR_STOP_SECOND: '600' }, { HARBOR_STOP_SECONDS: '3601' }, { HARBOR_APP_PORT: '80oops' }, { HARBOR_DRAIN_MS: '-1' },
    { HARBOR_STOP_SECONDS: '600', HARBOR_COMMAND_MS: '1000' },
    { HARBOR_HTTP_PATH: '/shutdown' }, { HARBOR_COMPLETION: 'exit' },
    { HARBOR_SHUTDOWN_MODE: 'http' },
    { HARBOR_SHUTDOWN_MODE: 'http', HARBOR_HTTP_PATH: '/drain', HARBOR_COMPLETION: 'http' },
    { HARBOR_SHUTDOWN_MODE: 'http', HARBOR_HTTP_PATH: '/drain', HARBOR_HTTP_STATUS_PATH: '/status' }
  ]) assert.throws(() => loadProxyEnv({ ...env, ...extra }));
});

test('environment CLI dry-run requires no Docker and never echoes REST credentials', async () => {
  const exec = promisify(execFile);
  const result = await exec(process.execPath, ['src/proxy-cli.js', '--env'], {
    env: { ...process.env, ...env, HARBOR_SHUTDOWN_MODE: 'http', HARBOR_HTTP_PATH: '/shutdown', HARBOR_HTTP_AUTHORIZATION: 'Bearer fixture-secret' }
  });
  assert.equal(JSON.parse(result.stdout).status, 'plan');
  assert.ok(!result.stdout.includes('fixture-secret'));
  await assert.rejects(exec(process.execPath, ['src/proxy-cli.js', 'examples/proxy/service.json', '--env']));
  const legacy = await exec(process.execPath, ['src/proxy-cli.js', 'examples/proxy/service.json'], { env: { ...process.env, HARBOR_IMAGE: 'invalid' } });
  assert.equal(JSON.parse(legacy.stdout).group, 'harbor-web');
});

test('HTTP acknowledgement does not stop a process before its long graceful exit', async () => {
  const f = fixture();
  Object.assign(f.c, loadProxyEnv({ ...env, HARBOR_SHUTDOWN_MODE: 'http', HARBOR_HTTP_PATH: '/shutdown' }));
  let clock = 0, initiatedAt;
  const admission = new ShutdownAdmission(f.admission, f.runtime, f.c, 'proxy', async () => {
    initiatedAt = clock; return new Response(null, { status: 202 });
  });
  f.runtime.inspect = async slot => {
    if (slot === 'blue' && initiatedAt !== undefined && clock - initiatedAt >= 600000) f.state.blue.running = false;
    return f.state[slot];
  };
  const deployer = new Deployer(f.c, f.runtime, admission, f.store, {
    now: () => clock, sleep: async ms => { clock += ms; }
  });
  const result = await deployer.run({ dryRun: false });
  assert.equal(result.forced, false);
  assert.ok(clock - initiatedAt >= 600000);
});

test('REST status completion also waits for existing proxy connections', async () => {
  const c = loadProxyEnv({ ...env, HARBOR_SHUTDOWN_MODE: 'http', HARBOR_HTTP_PATH: '/drain', HARBOR_COMPLETION: 'http', HARBOR_HTTP_STATUS_PATH: '/status' });
  const admission = new ShutdownAdmission({ sessions: async () => 2 }, {}, c, 'proxy', async () => new Response(JSON.stringify({ draining: true, sessions: 0 })));
  assert.equal(await admission.sessions('blue'), 2);
});
