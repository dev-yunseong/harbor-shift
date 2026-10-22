import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
const exec = promisify(execFile);

for (const mode of ['stdin', 'docker', 'http']) test(`bundled updater container: ${mode} shutdown, HTTP + WebSocket retention, unhealthy image`, { skip: process.env.HARBOR_DOCKER_TEST !== '1', timeout: 300000 }, async t => {
  const group = `hs-proxy-${randomBytes(6).toString('hex')}`, manager = `${group}-manager`, appImage = `${group}:app`, toolImage = `${group}:tool`;
  const directory = await mkdtemp(join(tmpdir(), `${group}-`));
  const names = [manager, `${group}-blue`, `${group}-green`], images = new Set();
  const docker = async (args, timeout = 30000) => (await exec('docker', ['--context', 'default', ...args], { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  const until = async (check, message, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 150)); }
    throw Error(message);
  };
  const build = async version => {
    await docker(['build', '--build-arg', `VERSION=${version}`, '-t', appImage, 'examples/proxy'], 120000);
    images.add(await docker(['image', 'inspect', '--format', '{{.Id}}', appImage]));
  };
  const state = async color => JSON.parse(await docker(['inspect', '--format', '{{json .State}}', `${group}-${color}`]));
  let ws, failed = true;
  try {
    await docker(['network', 'create', '--label', `harbor-shift.group=${group}`, group]);
    await build('v1');
    await docker(['build', '-t', toolImage, '.'], 120000);
    images.add(await docker(['image', 'inspect', '--format', '{{.Id}}', toolImage]));
    const config = { enabled: true, group, image: appImage, network: group, stateDir: '/state', appPort: 8080, listenPort: 8080,
      readinessPath: '/ready', memory: '128m', cpus: 1, pullPolicy: 'never', openStdin: true,
      shutdown: { initiate: { type: 'stdin', data: 'drain\n', timeoutMs: 3000 }, completion: { type: 'proxy' }, onFailure: 'keep-old' },
      timing: { requestMs: 1000, readyMs: 4000, pollMs: 100, stabilizeMs: 300, drainMs: 45000, stopSeconds: 3, commandMs: 30000, watchMs: 1000 } };
    const configFile = join(directory, 'service.json'); await writeFile(configFile, JSON.stringify(config));
    const source = mode === 'stdin'
      ? ['-v', `${configFile}:/config/service.json:ro`, toolImage, '/config/service.json', '--apply']
      : [
        ...Object.entries({
          HARBOR_ENABLED: 'true', HARBOR_GROUP: group, HARBOR_IMAGE: appImage, HARBOR_NETWORK: group,
          HARBOR_APP_PORT: '8080', HARBOR_READINESS_PATH: '/ready', HARBOR_MEMORY: '128m', HARBOR_CPUS: '1',
          HARBOR_PULL_POLICY: 'never', HARBOR_REQUEST_MS: '1000', HARBOR_READY_MS: '4000', HARBOR_POLL_MS: '100',
          HARBOR_STABILIZE_MS: '300', HARBOR_DRAIN_MS: '45000', HARBOR_STOP_SECONDS: '3', HARBOR_COMMAND_MS: '30000',
          HARBOR_WATCH_MS: '1000', HARBOR_SHUTDOWN_MODE: mode,
          ...(mode === 'http' ? { HARBOR_HTTP_PATH: '/drain', HARBOR_COMPLETION: 'http', HARBOR_HTTP_STATUS_PATH: '/status' } : {})
        }).flatMap(([key, value]) => ['-e', `${key}=${value}`]), toolImage, '--env', '--apply'
      ];
    await docker(['run', '-d', '--name', manager, '--label', `harbor-shift.group=${group}`, '--network', group,
      '-p', '127.0.0.1::8080', '-v', '/var/run/docker.sock:/var/run/docker.sock', ...source]);
    const mapping = await docker(['port', manager, '8080/tcp']);
    const base = `http://${mapping}`;
    await until(async () => { try { return (await (await fetch(base)).json()).version === 'v1'; } catch { return false; } }, 'Bundled proxy did not bootstrap');
    ws = new WebSocket(base.replace('http:', 'ws:')); await once(ws, 'open');
    const echo = async text => { const answer = once(ws, 'message'); ws.send(text); return (await answer)[0].data; };
    assert.equal(await echo('before'), 'v1:before');
    const work = fetch(`${base}/?ms=15000`).then(r => r.json()).then(value => ({ value }), error => ({ error }));
    await build('v2');
    await until(async () => { try { return (await (await fetch(base)).json()).version === 'v2'; } catch { return false; } }, 'Automatic image detection did not switch proxy');
    assert.equal((await state('blue')).Running, true);
    assert.equal(await echo('after'), 'v1:after', 'Established WebSocket must remain on old image');
    if (mode !== 'docker') await until(async () => (await docker(['logs', `${group}-blue`])).includes(`${mode}_drain_received`), 'Drain hook was not delivered');
    const oldWork = await work; if (oldWork.error) throw oldWork.error; assert.equal(oldWork.value.version, 'v1');
    assert.equal((await state('blue')).Running, true, 'Open WebSocket must prevent premature termination');
    const closed = once(ws, 'close'); ws.close(); await closed;
    await until(async () => !(await state('blue')).Running, 'Old container did not retire after tunnel close');
    const old = await state('blue'); assert.equal(old.ExitCode, 0);
    assert.match(await docker(['logs', `${group}-blue`]), /sigterm_received/);
    t.diagnostic('Bundled container: automatic update, retained HTTP and WebSocket, configured drain and graceful SIGTERM verified');
    await build('unhealthy');
    await until(async () => (await docker(['logs', manager])).includes('updates_paused'), 'Unhealthy replacement did not pause updates');
    assert.equal((await state('blue')).Running, false);
    assert.equal((await state('green')).Running, true);
    assert.equal((await (await fetch(base)).json()).version, 'v2');
    t.diagnostic('Unhealthy image rejected while existing proxy keeps serving v2; no automatic retry loop');
    failed = false;
  } finally {
    ws?.close();
    if (failed) for (const name of names) {
      t.diagnostic(await docker(['inspect', '--format', '{{.Name}} {{json .State}}', name]).catch(() => `${name}: absent`));
      t.diagnostic(await docker(['logs', '--tail', '30', name]).catch(() => `${name}: no logs`));
    }
    for (const name of names) {
      const owner = await docker(['inspect', '--format', '{{index .Config.Labels "harbor-shift.group"}}', name]).catch(() => null);
      if (owner === group) await docker(['rm', '-f', name]);
    }
    const owner = await docker(['network', 'inspect', '--format', '{{index .Labels "harbor-shift.group"}}', group]).catch(() => null);
    if (owner === group) await docker(['network', 'rm', group]);
    for (const tag of [appImage, toolImage]) await docker(['image', 'rm', tag]).catch(() => {});
    for (const id of images) await docker(['image', 'rm', id]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
