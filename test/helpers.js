import { Deployer } from '../src/deploy.js';
export function fixture(overrides = {}) {
  let clock = 0;
  const events = [], state = { blue: { running: true, image: 'old' }, green: null };
  const c = { group: 'test', timing: { readyMs: 5, requestMs: 2, pollMs: 1, stabilizeMs: 2, drainMs: 3 } };
  let route = { active: 'blue', revision: '0' }, journal = null, locked = false;
  const runtime = {
    inspect: async s => state[s], pull: async () => 'new',
    prepare: async s => { events.push(`prepare:${s}`); state[s] = { running: true, image: 'new' }; },
    stop: async s => { events.push(`stop:${s}`); if (state[s]) state[s].running = false; }
  };
  const admission = {
    route: async () => route,
    switchTo: async (s, revision) => { if (revision !== route.revision) throw Error('conflict'); events.push(`switch:${s}`); route = { active: s, revision: String(Number(revision) + 1) }; return route; },
    ready: async () => true, drain: async s => { events.push(`drain:${s}`); }, sessions: async () => 0
  };
  const store = {
    lock: async () => { if (locked) throw Error('locked'); locked = true; return async () => { locked = false; }; },
    pending: async () => journal, begin: async x => { journal = x; }, complete: async () => { journal = null; }
  };
  Object.assign(runtime, overrides.runtime); Object.assign(admission, overrides.admission);
  const deployer = new Deployer(c, runtime, admission, store, { now: () => clock, sleep: async ms => { clock += ms; }, log: e => events.push(e) });
  return { c, events, state, runtime, admission, store, deployer, route: () => route };
}
