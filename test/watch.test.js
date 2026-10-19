import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from '../src/watch.js';
import { fixture } from './helpers.js';

test('watch detects an updated image on next poll and stops cooperatively', async () => {
  const f = fixture(), cancel = new AbortController(); let polls = 0; const statuses = [];
  f.runtime.pull = async () => polls === 0 ? 'old' : 'new';
  await watch(async () => { statuses.push((await f.deployer.run({ dryRun: false })).status); if (++polls === 2) cancel.abort(); }, 1000, cancel.signal, async ms => assert.equal(ms, 1000));
  assert.deepEqual(statuses, ['unchanged', 'deployed']);
});
test('watch exits on first failure without retry', async () => {
  let attempts = 0;
  await assert.rejects(watch(async () => { attempts++; throw Error('failed'); }, 1000, new AbortController().signal), /failed/);
  assert.equal(attempts, 1);
});
