import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Docker } from '../src/docker.js';
import { Admission } from '../src/http.js';
import { Deployer } from '../src/deploy.js';
import { Store } from '../src/store.js';
import { validate } from '../src/config.js';

const exec = promisify(execFile);
const enabled = process.env.HARBOR_DOCKER_TEST === '1';

test('Docker Engine: switch with in-flight work, drain, retire, reject unhealthy update', { skip: !enabled, timeout: 240000 }, async t => {
  const group = `hs-ci-${randomBytes(6).toString('hex')}`;
  const image = `${group}:test`, controllerName = `${group}-controller`;
  const names = [controllerName, `${group}-blue`, `${group}-green`];
  const directory = await mkdtemp(join(tmpdir(), `${group}-`));
  const images = new Set();
  const token = 'isolated-ci-fixture-token'; // Public fixture credential, not a secret.
  async function docker(args, timeout = 30000) {
    return (await exec('docker', ['--context', 'default', ...args], { timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  }
  async function ports() {
    const servers = Array.from({ length: 3 }, () => createServer());
    try {
      await Promise.all(servers.map(s => new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); })));
      return servers.map(s => s.address().port);
    } finally { await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve)))); }
  }
  async function until(check, message, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(message);
  }
  async function request(url) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
    assert.equal(r.status, 200); return r.json();
  }
  async function build(version) {
    await docker(['build', '--build-arg', `VERSION=${version}`, '-t', image, 'examples/lab'], 120000);
    const id = await docker(['image', 'inspect', '--format', '{{.Id}}', image]); images.add(id); return id;
  }
  let failed = true;
  try {
    await docker(['info', '--format', '{{.OSType}}']).then(os => assert.equal(os, 'linux'));
    const [controllerPort, bluePort, greenPort] = await ports();
    await docker(['network', 'create', '--label', `harbor-shift.group=${group}`, group]);
    const first = await build('v1');
    await docker(['run', '-d', '--name', controllerName, '--label', `harbor-shift.group=${group}`, '--network', group,
      '-p', `127.0.0.1:${controllerPort}:8080`, '-e', 'MODE=controller', '-e', `HARBOR_TOKEN=${token}`, first]);
    const slots = {};
    for (const [color, port] of [['blue', bluePort], ['green', greenPort]]) {
      const envFile = join(directory, `${color}.env`);
      await writeFile(envFile, `HARBOR_TOKEN=${token}\nMODE=slot\nSLOT=${color}\nCONTROLLER=http://${controllerName}:8080\n`);
      slots[color] = { name: `${group}-${color}`, url: `http://127.0.0.1:${port}`, envFile, publish: [`127.0.0.1:${port}:8080`], memory: '128m', cpus: 1 };
    }
    const config = validate({ group, image, dockerContext: 'default', network: group, stateDir: join(directory, 'state'),
      controller: `http://127.0.0.1:${controllerPort}`, tokenEnv: 'HARBOR_TOKEN', allowHttp: true, slots,
      timing: { requestMs: 1000, readyMs: 5000, pollMs: 100, stabilizeMs: 300, drainMs: 45000, stopSeconds: 3, commandMs: 30000, watchMs: 1000 } });
    const runtime = new Docker(config);
    // Use only locally built images. No registry or package is published by this test.
    // All container operations use the real production Docker adapter unchanged.
    runtime.pull = async () => docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    const admission = new Admission(config, token), store = new Store(config.stateDir);
    const deployer = new Deployer(config, runtime, admission, store, { log: event => t.diagnostic(event) });
    await runtime.prepare('blue', first);
    await deployer.waitReady('blue');
    assert.equal((await deployer.run({ dryRun: false })).status, 'unchanged');
    const second = await build('v2'); assert.notEqual(second, first);
    const work = request(`${slots.blue.url}/work?ms=20000`).then(value => ({ value }), error => ({ error }));
    await until(async () => (await request(`${slots.blue.url}/status`)).sessions === 1, 'Initial work not accepted');
    const deployment = deployer.run({ dryRun: false }).then(value => ({ value }), error => ({ error }));
    await until(async () => (await admission.route()).active === 'green', 'Admission did not switch');
    assert.equal((await runtime.inspect('blue')).running, true, 'Old container must still serve accepted work');
    assert.equal((await request(`${slots.blue.url}/status`)).sessions, 1);
    const next = await request(`${slots.green.url}/work?ms=1`);
    assert.equal(next.slot, 'green'); assert.equal(next.version, 'v2');
    const completed = await work; if (completed.error) throw completed.error;
    assert.deepEqual(completed.value, { slot: 'blue', version: 'v1', completed: true });
    const result = await deployment; if (result.error) throw result.error;
    assert.deepEqual(result.value, { status: 'deployed', active: 'green', forced: false });
    assert.equal((await runtime.inspect('blue')).running, false);
    assert.equal((await runtime.inspect('green')).image, second);
    assert.equal(await store.pending(), null);
    t.diagnostic('Real engine: old v1 request completed; new v2 request served; old slot stopped');

    await build('v3-unhealthy');
    await writeFile(slots.blue.envFile, `HARBOR_TOKEN=${token}\nMODE=slot\nSLOT=blue\nCONTROLLER=http://${controllerName}:8080\nUNHEALTHY=1\n`);
    await assert.rejects(deployer.run({ dryRun: false }), /readiness deadline/);
    assert.equal((await admission.route()).active, 'green');
    assert.equal((await runtime.inspect('green')).running, true);
    assert.equal((await runtime.inspect('green')).image, second);
    assert.equal((await runtime.inspect('blue')).running, false);
    assert.equal((await request(`${slots.green.url}/work?ms=1`)).version, 'v2');
    assert.equal(await store.pending(), null);
    t.diagnostic('Real engine: unhealthy v3 rejected; v2 remained active and served work');
    failed = false;
  } finally {
    if (failed) {
      for (const name of names) {
        // Only state metadata and fixture logs: never inspect environment or credentials.
        t.diagnostic(await docker(['inspect', '--format', '{{.Name}} {{json .State}}', name]).catch(() => `${name}: absent`));
        t.diagnostic(await docker(['logs', '--tail', '20', name]).catch(() => `${name}: no logs`));
      }
    }
    for (const name of names) {
      const owner = await docker(['inspect', '--format', '{{index .Config.Labels "harbor-shift.group"}}', name]).catch(() => null);
      if (owner === group) await docker(['rm', '-f', name]);
    }
    const networkOwner = await docker(['network', 'inspect', '--format', '{{index .Labels "harbor-shift.group"}}', group]).catch(() => null);
    if (networkOwner === group) await docker(['network', 'rm', group]);
    await docker(['image', 'rm', image]).catch(() => {});
    for (const id of images) await docker(['image', 'rm', id]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
