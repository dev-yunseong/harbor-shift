import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Admission } from '../src/http.js';
import { Deployer } from '../src/deploy.js';
import { fixture } from './helpers.js';

test('real lab HTTP services preserve accepted work across a deployment (runtime mocked)', { timeout: 10000 }, async () => {
  const children = [];
  async function start(extra) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../examples/lab/server.js', import.meta.url))], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', HARBOR_TOKEN: 'fixture-token', ...extra }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    children.push(child);
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, 'line'); lines.close();
    return `http://127.0.0.1:${JSON.parse(line).port}`;
  }
  const headers = { authorization: 'Bearer fixture-token' };
  try {
    const controller = await start({ MODE: 'controller' });
    const blue = await start({ MODE: 'slot', SLOT: 'blue', CONTROLLER: controller });
    const green = await start({ MODE: 'slot', SLOT: 'green', CONTROLLER: controller });
    const f = fixture();
    const c = { controller, slots: { blue: { url: blue }, green: { url: green } }, timing: { requestMs: 1000, readyMs: 2000, pollMs: 10, stabilizeMs: 20, drainMs: 2000 } };
    const a = new Admission(c, 'fixture-token');
    const work = fetch(`${blue}/work?ms=300`, { headers }).then(r => r.json());
    // Confirm acceptance before switching rather than relying on a timing sleep.
    for (let i = 0; i < 100; i++) {
      const status = await (await fetch(`${blue}/status`, { headers })).json();
      if (status.sessions === 1) break;
      if (i === 99) throw Error('work was not accepted');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const d = new Deployer(c, f.runtime, a, f.store);
    const result = await d.run({ dryRun: false });
    assert.equal(result.forced, false); assert.equal((await work).slot, 'blue');
    assert.equal((await a.route()).active, 'green');
    assert.equal((await fetch(`${blue}/work`, { headers })).status, 503);
    const next = await (await fetch(`${green}/work?ms=1`, { headers })).json(); assert.equal(next.slot, 'green');
  } finally {
    await Promise.all(children.map(async child => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }));
  }
});
