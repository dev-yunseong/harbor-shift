import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export class Deployer {
  constructor(config, runtime, admission, store, options = {}) {
    this.c = config; this.runtime = runtime; this.admission = admission; this.store = store;
    this.now = options.now || (() => performance.now()); this.sleep = options.sleep || sleep;
    this.log = options.log || (() => {});
  }
  async waitReady(slot) {
    const end = this.now() + this.c.timing.readyMs;
    while (this.now() < end) {
      if (!(await this.runtime.inspect(slot))?.running) throw Error('Candidate exited');
      try { if (await this.admission.ready(slot, Math.min(this.c.timing.requestMs, Math.max(1, end - this.now())))) return; } catch { /* bounded readiness retry */ }
      await this.sleep(Math.min(this.c.timing.pollMs, Math.max(1, end - this.now())));
    }
    throw Error('Candidate readiness deadline exceeded');
  }
  async stabilize(slot) {
    const end = this.now() + this.c.timing.stabilizeMs;
    do {
      if (!(await this.runtime.inspect(slot))?.running || !await this.admission.ready(slot)) throw Error('Candidate failed after switch');
      await this.sleep(Math.min(this.c.timing.pollMs, Math.max(1, end - this.now())));
    } while (this.now() < end);
  }
  async retire(slot) {
    await this.admission.drain(slot); // Uncertain/failed drain must not force-kill a serving slot.
    const end = this.now() + this.c.timing.drainMs;
    let exhausted = true;
    while (this.now() < end) {
      if (!(await this.runtime.inspect(slot))?.running) { exhausted = false; break; }
      if (await this.admission.sessions(slot, Math.min(this.c.timing.requestMs, Math.max(1, end - this.now()))) === 0) { exhausted = false; break; }
      await this.sleep(Math.min(this.c.timing.pollMs, Math.max(1, end - this.now())));
    }
    this.log(exhausted ? 'drain_timeout: SIGTERM then bounded SIGKILL; sessions may disconnect' : 'drain_complete');
    await this.runtime.stop(slot);
    return exhausted;
  }
  async rollback(old, candidate) {
    if (!(await this.runtime.inspect(old))?.running || !await this.admission.ready(old)) throw Error('Old slot unavailable for rollback');
    const route = await this.admission.route();
    if (route.active !== old) await this.admission.switchTo(old, route.revision);
    // Candidate may already have accepted sessions, even after a lost switch response.
    await this.retire(candidate);
    await this.store.complete();
    this.log('rolled_back');
  }
  async run({ dryRun = true } = {}) {
    if (dryRun) return { status: 'plan', group: this.c.group, steps: ['pull and compare image ID', 'prepare inactive slot', 'wait ready', 'CAS admission switch', 'observe health', 'drain old sessions', 'SIGTERM / SIGKILL if deadline expires'], note: 'No Docker, HTTP, filesystem writes, or registry checks performed' };
    const unlock = await this.store.lock();
    try {
      if (await this.store.pending()) throw Error('Unfinished transaction: operator reconciliation required');
      const route = await this.admission.route(), old = route.active, candidate = old === 'blue' ? 'green' : 'blue';
      const active = await this.runtime.inspect(old), idle = await this.runtime.inspect(candidate);
      if (!active?.running || idle?.running) throw Error('Expected one active running slot and an absent/stopped candidate');
      if (!await this.admission.ready(old)) throw Error('Active slot is not ready');
      const image = await this.runtime.pull();
      if (active.image === image) return { status: 'unchanged' };
      await this.store.begin({ old, candidate, image, initialRevision: route.revision, started: new Date().toISOString() });
      // A timed-out Docker command may still complete at the daemon. Keep its journal.
      await this.runtime.prepare(candidate, image);
      try {
        await this.waitReady(candidate);
      } catch (e) {
        // No switch request was issued. The controller contract excludes this slot.
        await this.runtime.stop(candidate);
        await this.store.complete();
        throw e;
      }
      try {
        await this.admission.switchTo(candidate, route.revision);
        await this.stabilize(candidate);
      } catch (e) {
        try { await this.rollback(old, candidate); }
        catch { throw Error('Rollback incomplete: preserve both slots; reconcile transaction and controller before retry'); }
        throw Error('Deployment failed; admission rolled back and candidate retired');
      }
      // Point of no automatic rollback: drain may be irreversible in the application.
      const forced = await this.retire(old);
      await this.store.complete();
      return { status: 'deployed', active: candidate, forced };
    } finally { await unlock(); }
  }
}
