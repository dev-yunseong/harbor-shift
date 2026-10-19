// Disposable teaching fixture, not a production admission controller.
import { createServer } from 'node:http';
const token = process.env.HARBOR_TOKEN;
if (!token) throw Error('HARBOR_TOKEN required');
const mode = process.env.MODE || 'slot', color = process.env.SLOT || 'blue';
let active = 'blue', revision = 0, draining = false, sessions = 0;
const server = createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  try {
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    const url = new URL(req.url, 'http://localhost');
    if (mode === 'controller') {
      if (url.pathname === '/route' && req.method === 'PUT') {
        let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 4096) return send(413, {}); }
        const body = JSON.parse(text);
        if (body.expectedRevision !== String(revision)) return send(409, { error: 'conflict' });
        if (!['blue', 'green'].includes(body.active)) return send(400, {});
        active = body.active; revision++;
      }
      if (url.pathname === '/route') return send(200, { active, revision: String(revision) });
      if (url.pathname === '/assign') return send(200, { active, url: `http://127.0.0.1:${active === 'blue' ? 9101 : 9102}/work?ms=15000` });
      return send(404, {});
    }
    if (url.pathname === '/ready') return send(200, { ready: !draining && process.env.UNHEALTHY !== '1' });
    if (url.pathname === '/drain' && req.method === 'POST') { draining = true; return send(200, { draining }); }
    if (url.pathname === '/status') return send(200, { draining, sessions });
    if (url.pathname === '/work') {
      const response = await fetch(`${process.env.CONTROLLER}/route`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      const route = await response.json();
      if (!response.ok || draining || route.active !== color) return send(503, { error: 'not accepting new work' });
      const ms = Number(url.searchParams.get('ms') || 1000);
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > 60000) return send(400, {});
      sessions++;
      // Count accepted work until it actually finishes, even if the client disconnects.
      setTimeout(() => { sessions--; send(200, { slot: color, version: process.env.VERSION || 'v1', completed: true }); }, ms);
      return;
    }
    return send(404, {});
  } catch { if (!res.headersSent) send(503, { error: 'fixture unavailable' }); }
});
server.requestTimeout = 5000;
server.listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0', () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
process.on('SIGTERM', () => { draining = true; server.close(); });
