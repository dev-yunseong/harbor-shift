import http from 'node:http';

export function validateShutdown(value) {
  if (value === undefined) return;
  const object = (x, fields, label) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw Error(`Invalid ${label}`);
    for (const k of Object.keys(x)) if (!fields.includes(k)) throw Error(`Unknown ${label} field: ${k}`);
  };
  const endpoint = x => {
    if (typeof x.path !== 'string' || !/^\/(?!\/)[^\s#]*$/.test(x.path)) throw Error('Hook HTTP path must be relative');
    if (x.url !== undefined) {
      const u = new URL(x.url.replaceAll('{slot}', 'slot'));
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw Error('Invalid hook URL');
    }
    if (x.headersEnv !== undefined) {
      object(x.headersEnv, Object.keys(x.headersEnv), 'headersEnv');
      for (const [name, env] of Object.entries(x.headersEnv)) if (!/^[A-Za-z0-9-]+$/.test(name) || !/^[A-Z_][A-Z0-9_]*$/.test(env)) throw Error('headersEnv maps headers to environment variable names');
    }
    if (!Number.isSafeInteger(x.timeoutMs) || x.timeoutMs < 1 || x.timeoutMs > 300000) throw Error('Hook timeoutMs must be 1..300000');
  };
  object(value, ['initiate', 'completion', 'onFailure'], 'shutdown');
  if (value.onFailure !== undefined && !['keep-old', 'force-stop'].includes(value.onFailure)) throw Error('Invalid shutdown.onFailure');
  if (value.initiate) {
    const x = value.initiate;
    if (x.type === 'exec') {
      object(x, ['type', 'argv', 'timeoutMs'], 'exec hook');
      if (!Array.isArray(x.argv) || !x.argv.length || x.argv.some(a => typeof a !== 'string' || !a.length || a.includes('\0'))) throw Error('exec hook requires nonempty argv strings');
    } else if (x.type === 'stdin') {
      object(x, ['type', 'data', 'timeoutMs'], 'stdin hook');
      if (typeof x.data !== 'string' || !x.data || Buffer.byteLength(x.data) > 16384) throw Error('stdin hook data must be 1..16384 bytes');
    } else if (x.type === 'http') {
      object(x, ['type', 'path', 'url', 'method', 'headersEnv', 'body', 'timeoutMs'], 'HTTP hook'); endpoint(x);
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(x.method)) throw Error('Hook HTTP method must be explicit POST/PUT/PATCH/DELETE');
    } else throw Error('Unknown shutdown initiation transport');
    if (!Number.isSafeInteger(x.timeoutMs) || x.timeoutMs < 1 || x.timeoutMs > 300000) throw Error('Hook timeoutMs must be 1..300000');
  }
  if (value.completion) {
    const x = value.completion;
    if (x.type === 'http') { object(x, ['type', 'path', 'url', 'headersEnv', 'timeoutMs'], 'HTTP completion'); endpoint(x); }
    else if (['proxy', 'exit', 'adapter'].includes(x.type)) object(x, ['type'], 'completion');
    else throw Error('Unknown shutdown completion type');
  }
}

// Docker attach is a hijacked HTTP connection to the original process stdin.
// Resolving means bytes were written, not that the application acknowledged them.
export async function attachStdin(socketPath, name, data, timeoutMs, requester = http.request) {
  await new Promise((resolve, reject) => {
    let socket, request, done = false;
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer);
      socket?.destroy(); request?.destroy();
      error ? reject(Error('stdin attachment failed or timed out; delivery uncertain')) : resolve();
    };
    const timer = setTimeout(() => finish(Error('timeout')), timeoutMs);
    request = requester({ socketPath, method: 'POST', path: `/containers/${encodeURIComponent(name)}/attach?stream=1&stdin=1&stdout=0&stderr=0`,
      headers: { Connection: 'Upgrade', Upgrade: 'tcp' } });
    request.once('upgrade', (response, attached) => {
      socket = attached;
      if (response.statusCode !== 101) return finish(Error('unexpected status'));
      socket.once('error', finish);
      socket.write(data, error => finish(error));
    });
    request.once('response', () => finish(Error('attach rejected')));
    request.once('error', finish); request.end();
  });
}

export class ShutdownAdmission {
  constructor(base, runtime, config, mode = 'adapter', fetcher = fetch) { this.base = base; this.runtime = runtime; this.c = config; this.mode = mode; this.fetch = fetcher; }
  route() { return this.base.route(); }
  switchTo(...args) { return this.base.switchTo(...args); }
  ready(...args) { return this.base.ready(...args); }
  async request(slot, hook, method, timeout) {
    try {
      const headers = { 'content-type': 'application/json' };
      for (const [name, env] of Object.entries(hook.headersEnv || {})) {
        if (!process.env[env]) throw Error('Missing header environment variable');
        headers[name] = process.env[env];
      }
      const base = hook.url ? hook.url.replaceAll('{slot}', this.c.slots[slot].name) : this.c.slots[slot].url;
      const r = await this.fetch(`${base.replace(/\/$/, '')}${hook.path}`, { method, headers, redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(hook.timeoutMs, timeout ?? hook.timeoutMs)))),
        body: method === 'GET' || hook.body === undefined ? undefined : JSON.stringify(hook.body) });
      if (!r.ok) { await r.body?.cancel(); throw Error('HTTP failure'); }
      if (method !== 'GET') { await r.body?.cancel(); return; }
      const reader = r.body.getReader(); const chunks = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
        if (size > 16384) { await reader.cancel(); throw Error('oversized'); } chunks.push(Buffer.from(value)); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value.draining !== true || !Number.isSafeInteger(value.sessions) || value.sessions < 0) throw Error('Invalid completion');
      return value.sessions;
    } catch { throw Error('Shutdown HTTP hook failed (details redacted)'); }
  }
  async drain(slot) {
    // Proxy stops routing first; advanced adapter's default drain remains its API.
    const hook = this.c.shutdown?.initiate;
    if (this.mode === 'proxy' || !hook) await this.base.drain(slot);
    if (!hook) return;
    // Recheck ownership before executing any user-specified hook.
    if (!(await this.runtime.inspect(slot))?.running) throw Error('Hook target is not running');
    if (hook.type === 'exec') await this.runtime.execHook(slot, hook.argv, hook.timeoutMs);
    else if (hook.type === 'stdin') await this.runtime.stdinHook(slot, hook.data, hook.timeoutMs);
    else await this.request(slot, hook, hook.method);
  }
  async sessions(slot, timeout) {
    const completion = this.c.shutdown?.completion;
    if (!completion || completion.type === 'adapter') return this.base.sessions(slot, timeout);
    if (completion.type === 'proxy') {
      if (this.mode !== 'proxy') throw Error('Proxy completion is unavailable in advanced mode');
      return this.base.sessions(slot);
    }
    if (completion.type === 'exit') return 1; // Deployer independently checks process exit before this call.
    const remaining = await this.request(slot, completion, 'GET', timeout);
    return this.mode === 'proxy' ? Math.max(remaining, await this.base.sessions(slot)) : remaining;
  }
}
