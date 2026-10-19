#!/usr/bin/env node
import { loadProxyConfig } from './proxy-config.js';
import { ProxyAdmission } from './proxy.js';
import { Docker } from './docker.js';
import { Store } from './store.js';
import { Deployer } from './deploy.js';
import { watch } from './watch.js';
import { ShutdownAdmission } from './shutdown.js';

export async function serve(config, { apply = false, signal = new AbortController().signal, log = console.log } = {}) {
  if (!apply) return { status: 'plan', group: config.group, mode: 'bundled HTTP/WebSocket proxy', note: 'No Docker, HTTP or state mutation; --apply enables bootstrap, proxy and polling' };
  const store = new Store(config.stateDir), unlock = await store.lock();
  const proxy = new ProxyAdmission(config), runtime = new Docker(config);
  // One lock covers the complete daemon lifetime, including bootstrap and traffic serving.
  const lockedStore = { lock: async () => async () => {}, pending: () => store.pending(), begin: x => store.begin(x), complete: () => store.complete() };
  const prepare = runtime.prepare.bind(runtime);
  runtime.prepare = async (slot, image) => { await prepare(slot, image); proxy.reset(slot); };
  const deployer = new Deployer(config, runtime, new ShutdownAdmission(proxy, runtime, config, 'proxy'), lockedStore, { log });
  try {
    if (await store.pending()) throw Error('Unfinished transaction; reconcile before starting proxy');
    if (!await proxy.load()) {
      if (await runtime.inspect('blue') || await runtime.inspect('green')) throw Error('No route state but existing slots; manual reconciliation required');
      const image = await runtime.pull();
      await store.begin({ bootstrap: true, candidate: 'blue', image });
      await runtime.prepare('blue', image); await deployer.waitReady('blue');
      const state = { active: 'blue', revision: '0' }; await proxy.persist(state); proxy.state = state;
      await store.complete();
    } else {
      const active = (await proxy.route()).active, other = active === 'blue' ? 'green' : 'blue';
      if (!(await runtime.inspect(active))?.running || (await runtime.inspect(other))?.running) throw Error('Persisted route does not match running slots');
      if (!await proxy.ready(active)) throw Error('Persisted active slot not ready');
    }
    await proxy.listen(config.listenPort);
    log(JSON.stringify({ event: 'proxy_listening', port: config.listenPort }));
    try {
      await watch(async () => log(JSON.stringify(await deployer.run({ dryRun: false }))), config.timing.watchMs, signal);
    } catch (e) {
      // Fail polling closed, but keep the existing proxy route alive for operators.
      // Exiting here would unnecessarily drop every healthy client connection.
      log(JSON.stringify({ event: 'updates_paused', reason: e.message }));
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }
    return { status: 'stopped' };
  } finally { await proxy.close(); await unlock(); }
}
