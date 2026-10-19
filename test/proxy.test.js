import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ProxyAdmission } from '../src/proxy.js';

test('built-in proxy switches new HTTP/WS while retaining old requests and tunnels', { timeout: 10000 }, async () => {
  const backendSockets = new Set();
  let releaseWork, accepted;
  const workAccepted = new Promise(resolve => { accepted = resolve; });
  const make = async name => {
    const server = createServer((req, res) => {
      if (req.url === '/hold') { releaseWork = () => res.end(name); accepted(); } else res.end(name);
    });
    server.on('upgrade', (req, socket) => {
      backendSockets.add(socket); socket.on('close', () => backendSockets.delete(socket));
      const key = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
      socket.on('data', () => socket.write(Buffer.from([0x81, name.length, ...Buffer.from(name)])));
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server;
  };
  const blue = await make('blue'), green = await make('green');
  const proxy = new ProxyAdmission({ stateDir: '.', readinessPath: '/', readinessStatus: 200, timing: { requestMs: 1000 },
    slots: { blue: { url: `http://127.0.0.1:${blue.address().port}` }, green: { url: `http://127.0.0.1:${green.address().port}` } } }, { persist: async () => {} });
  proxy.state = { active: 'blue', revision: '0' };
  const address = await proxy.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
  let ws;
  try {
    const hold = fetch(`${base}/hold`).then(r => r.text()); await workAccepted;
    ws = new WebSocket(base.replace('http:', 'ws:')); await once(ws, 'open');
    let message = once(ws, 'message'); ws.send('before'); assert.equal((await message)[0].data, 'blue');
    await proxy.switchTo('green', '0'); await proxy.drain('blue');
    assert.equal(await proxy.sessions('blue'), 2);
    assert.equal(await (await fetch(base)).text(), 'green');
    message = once(ws, 'message'); ws.send('after'); assert.equal((await message)[0].data, 'blue');
    releaseWork(); assert.equal(await hold, 'blue');
    await assert.rejects(proxy.switchTo('blue', '0'), /conflict/);
  } finally {
    await proxy.close();
    for (const socket of backendSockets) socket.destroy();
    blue.closeAllConnections(); green.closeAllConnections();
    await Promise.all([new Promise(r => blue.close(r)), new Promise(r => green.close(r))]);
  }
});

test('proxy switch persistence failure leaves previous route intact', async () => {
  const proxy = new ProxyAdmission({ stateDir: '.', slots: {}, timing: {} }, { persist: async () => { throw Error('disk failure'); } });
  proxy.state = { active: 'blue', revision: '0' };
  await assert.rejects(proxy.switchTo('green', '0'), /disk failure/);
  assert.equal((await proxy.route()).active, 'blue');
});
