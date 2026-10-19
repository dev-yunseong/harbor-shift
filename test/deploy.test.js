import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
const apply = { dryRun: false };

test('dry run has no adapter or store calls', async () => {
  const f = fixture(); for (const object of [f.runtime, f.admission, f.store]) for (const k of Object.keys(object)) object[k] = () => { throw Error('called'); };
  assert.equal((await f.deployer.run()).status, 'plan');
});
test('ready, switch, drain, stop ordering', async () => {
  const f = fixture(); assert.deepEqual(await f.deployer.run(apply), { status: 'deployed', active: 'green', forced: false });
  assert.deepEqual(f.events, ['prepare:green', 'switch:green', 'drain:blue', 'drain_complete', 'stop:blue']);
  assert.equal(await f.store.pending(), null);
});
test('same image is a no-op', async () => {
  const f = fixture({ runtime: { pull: async () => 'old' } }); assert.equal((await f.deployer.run(apply)).status, 'unchanged'); assert.deepEqual(f.events, []);
});
test('unhealthy candidate leaves active slot untouched', async () => {
  const f = fixture({ admission: { ready: async s => s === 'blue' } });
  await assert.rejects(f.deployer.run(apply), /readiness/); assert.equal(f.state.blue.running, true);
  assert.deepEqual(f.events, ['prepare:green', 'stop:green']);
});
test('switch rejection rolls back without retiring old', async () => {
  const f = fixture({ admission: { switchTo: async () => { throw Error('switch rejected'); } } });
  await assert.rejects(f.deployer.run(apply), /rolled back/);
  assert.equal(f.state.blue.running, true); assert.equal(f.state.green.running, false);
});
test('lost switch response is reconciled and candidate sessions drain on rollback', async () => {
  const f = fixture(), original = f.admission.switchTo;
  f.admission.switchTo = async (s, r) => { const result = await original(s, r); if (s === 'green') throw Error('lost response'); return result; };
  await assert.rejects(f.deployer.run(apply), /rolled back/);
  assert.equal(f.route().active, 'blue'); assert.ok(f.events.indexOf('switch:blue') < f.events.indexOf('drain:green'));
});
test('post-switch health failure rolls back', async () => {
  const f = fixture(); f.admission.ready = async s => s === 'blue' || f.route().active === 'blue';
  await assert.rejects(f.deployer.run(apply), /rolled back/); assert.equal(f.route().active, 'blue');
});
test('rollback failure preserves both slots and blocks next run', async () => {
  const f = fixture(), original = f.admission.switchTo;
  f.admission.switchTo = async (s, r) => { if (s === 'blue') throw Error('rollback failed'); await original(s, r); throw Error('lost reply'); };
  await assert.rejects(f.deployer.run(apply), /Rollback incomplete/);
  assert.ok(f.state.blue.running && f.state.green.running); assert.ok(await f.store.pending());
  await assert.rejects(f.deployer.run(apply), /Unfinished transaction/);
});
test('drain timeout invokes bounded stop and reports forced retirement', async () => {
  const f = fixture({ admission: { sessions: async () => 9 } });
  assert.equal((await f.deployer.run(apply)).forced, true); assert.ok(f.events.some(x => x.startsWith('drain_timeout')));
});
test('drain request failure does not kill old or attempt unsafe reactivation', async () => {
  const f = fixture({ admission: { drain: async () => { throw Error('drain failed'); } } });
  await assert.rejects(f.deployer.run(apply), /drain failed/); assert.equal(f.state.blue.running, true); assert.ok(await f.store.pending());
});
test('ambiguous Docker preparation keeps journal for reconciliation', async () => {
  const f = fixture({ runtime: { prepare: async () => { throw Error('uncertain'); } } });
  await assert.rejects(f.deployer.run(apply), /uncertain/); assert.ok(await f.store.pending());
});
test('two running slots fail closed before pulling', async () => {
  const f = fixture(); f.state.green = { running: true }; f.runtime.pull = () => { throw Error('should not pull'); };
  await assert.rejects(f.deployer.run(apply), /Expected one/);
});
test('concurrent invocations serialize', async () => {
  const f = fixture(); const release = await f.store.lock(); await assert.rejects(f.deployer.run(apply), /locked/); await release();
});
