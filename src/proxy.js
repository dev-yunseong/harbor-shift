import http from 'node:http';
import { readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';

const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function clean(headers) {
  const result = { ...headers };
  for (const name of [...hop, ...(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]) delete result[name];
  return result;
}

// Single-process admission authority. In-flight HTTP requests and upgrade tunnels
// keep their selected upstream; each new request reads the current route.
export class ProxyAdmission {
  constructor(config, options = {}) {
    this.c = config; this.state = null; this.counts = { blue: 0, green: 0 };
    this.draining = { blue: false, green: false }; this.clients = new Set();
    this.file = join(config.stateDir, 'route.json'); this.persist = options.persist || (state => this.save(state));
    this.server = http.createServer((req, res) => this.forward(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.on('connection', socket => { this.clients.add(socket); socket.on('close', () => this.clients.delete(socket)); });
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = config.proxyRequestMs || 300000;
  }
  async load() {
    try {
      const s = JSON.parse(await readFile(this.file, 'utf8'));
      if (!['blue', 'green'].includes(s.active) || !/^\d+$/.test(s.revision)) throw Error('Invalid persisted route');
      this.state = s;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this.state;
  }
  async save(state) {
    const temp = `${this.file}.tmp`, handle = await open(temp, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, this.file);
  }
  async route() { if (!this.state) throw Error('Proxy not bootstrapped'); return { ...this.state }; }
  async switchTo(slot, expectedRevision) {
    if (!['blue', 'green'].includes(slot) || this.draining[slot] || this.state?.revision !== expectedRevision) throw Error('Proxy route conflict');
    const state = { active: slot, revision: String(BigInt(expectedRevision) + 1n) };
    await this.persist(state); this.state = state; return { ...state };
  }
  reset(slot) { this.draining[slot] = false; }
  async ready(slot, timeout = this.c.timing.requestMs) {
    if (this.draining[slot]) return false;
    try {
      const r = await fetch(`${this.c.slots[slot].url}${this.c.readinessPath}`, {
        redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.floor(timeout)))
      });
      await r.body?.cancel(); return r.status === this.c.readinessStatus;
    } catch { return false; }
  }
  async drain(slot) {
    if (this.state?.active === slot) throw Error('Cannot drain active proxy route');
    this.draining[slot] = true;
  }
  async sessions(slot) { if (!this.draining[slot]) throw Error('Slot is not draining'); return this.counts[slot]; }
  acquire() {
    const slot = this.state?.active;
    if (!slot || this.draining[slot]) return null;
    this.counts[slot]++; let released = false;
    return { slot, release: () => { if (!released) { released = true; this.counts[slot]--; } } };
  }
  upstream(req, slot, upgrade = false) {
    const headers = clean(req.headers);
    delete headers.forwarded; delete headers['x-forwarded-host'];
    headers['x-forwarded-for'] = req.socket.remoteAddress || '';
    headers['x-forwarded-proto'] = 'http';
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return http.request(new URL(this.c.slots[slot].url), { method: req.method, path: req.url, headers, agent: false });
  }
  forward(req, res) {
    if (!req.url.startsWith('/')) { res.writeHead(400); res.end(); return; }
    const lease = this.acquire();
    if (!lease) { res.writeHead(503); res.end('No ready upstream'); return; }
    const upstream = this.upstream(req, lease.slot);
    const finish = () => { upstream.destroy(); lease.release(); };
    res.once('close', finish); res.once('finish', finish);
    req.once('aborted', finish);
    upstream.setTimeout(this.c.proxyRequestMs || 300000, () => upstream.destroy(Error('Upstream timeout')));
    upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('Upstream unavailable'); } else res.destroy(); });
    upstream.on('response', response => {
      res.writeHead(response.statusCode, clean(response.headers));
      response.on('error', () => res.destroy()); response.pipe(res);
    });
    req.pipe(upstream);
  }
  upgrade(req, socket, head) {
    if (!req.url.startsWith('/') || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    const lease = this.acquire();
    if (!lease) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    const upstream = this.upstream(req, lease.slot, true); let peer;
    const finish = () => { upstream.destroy(); peer?.destroy(); socket.destroy(); lease.release(); };
    socket.once('close', finish); socket.once('error', finish);
    upstream.once('error', finish);
    const timer = setTimeout(finish, this.c.timing.requestMs);
    upstream.once('upgrade', (response, backend, backendHead) => {
      clearTimeout(timer); peer = backend;
      backend.once('close', finish); backend.once('error', finish);
      let headers = `HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`;
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers += `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`;
      socket.write(`${headers}\r\n`);
      if (backendHead.length) socket.write(backendHead);
      if (head.length) backend.write(head);
      socket.pipe(backend); backend.pipe(socket);
    });
    upstream.once('response', () => { clearTimeout(timer); finish(); });
    upstream.once('error', () => clearTimeout(timer));
    upstream.end();
  }
  async listen(port, host = '0.0.0.0') {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, host, resolve); });
    return this.server.address();
  }
  async close() {
    const finished = new Promise(resolve => this.server.close(resolve));
    for (const socket of this.clients) socket.destroy();
    await finished;
  }
}
