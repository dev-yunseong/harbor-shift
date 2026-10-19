export class Admission {
  constructor(config, token, fetcher = fetch) { this.c = config; this.token = token; this.fetch = fetcher; }
  async request(base, path, method = 'GET', body, timeout = this.c.timing.requestMs) {
    try {
      const response = await this.fetch(`${base.replace(/\/$/, '')}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.floor(timeout))),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!response.ok) throw Error('status');
      // Bound response memory; the abort signal also covers reading the body.
      const reader = response.body.getReader(); let bytes = 0; const chunks = [];
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length;
        if (bytes > 16384) { await reader.cancel(); throw Error('oversized'); } chunks.push(Buffer.from(value)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw Error(`Admission ${method} request failed (details redacted)`); }
  }
  async route() {
    const r = await this.request(this.c.controller, '/route');
    if (!['blue', 'green'].includes(r.active) || typeof r.revision !== 'string' || !r.revision) throw Error('Invalid route response');
    return r;
  }
  async switchTo(slot, expectedRevision) {
    await this.request(this.c.controller, '/route', 'PUT', { active: slot, expectedRevision });
    const r = await this.route();
    if (r.active !== slot || r.revision === expectedRevision) throw Error('Switch not acknowledged');
    return r;
  }
  async ready(slot, timeout) { const r = await this.request(this.c.slots[slot].url, '/ready', 'GET', undefined, timeout); return r.ready === true; }
  async drain(slot) { const r = await this.request(this.c.slots[slot].url, '/drain', 'POST', {}); if (r.draining !== true) throw Error('Drain not acknowledged'); }
  async sessions(slot, timeout) {
    const r = await this.request(this.c.slots[slot].url, '/status', 'GET', undefined, timeout);
    if (r.draining !== true || !Number.isSafeInteger(r.sessions) || r.sessions < 0) throw Error('Invalid drain status');
    return r.sessions;
  }
}
