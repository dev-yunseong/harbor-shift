// Isolated HTTP/WebSocket test application; no custom admission API required.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const version = process.env.VERSION || 'v1';
let draining = false, work = 0;
const tunnels = new Set();
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ready') { res.writeHead(draining || version === 'unhealthy' ? 503 : 200); res.end(); return; }
  if (url.pathname === '/drain' && req.method === 'POST') { draining = true; console.log('http_drain_received'); res.writeHead(202); res.end(); return; }
  if (url.pathname === '/status') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ draining, sessions: work + tunnels.size })); return; }
  const ms = Number(url.searchParams.get('ms') || 0);
  if (draining || !Number.isSafeInteger(ms) || ms < 0 || ms > 60000) { res.writeHead(503); res.end(); return; }
  work++;
  setTimeout(() => { work--; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version, slot: process.env.SLOT || 'unset' })); }, ms);
});
server.on('upgrade', (req, socket) => {
  if (draining || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  tunnels.add(socket); socket.on('close', () => tunnels.delete(socket));
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 15, size = buffer[1] & 127;
      if (size >= 126 || !(buffer[1] & 128)) { socket.destroy(); return; }
      if (buffer.length < 6 + size) return;
      const mask = buffer.subarray(2, 6), payload = buffer.subarray(6, 6 + size);
      for (let i = 0; i < size; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(6 + size);
      if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
      if (opcode !== 1) continue;
      const answer = Buffer.from(`${version}:${payload.toString()}`);
      socket.write(Buffer.concat([Buffer.from([0x81, answer.length]), answer]));
    }
  });
});
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', text => { input += text; if (input.includes('drain\n')) { draining = true; console.log('stdin_drain_received'); input = ''; } });
process.on('SIGTERM', () => { console.log('sigterm_received'); draining = true; server.close(() => process.exit(0)); });
server.listen(Number(process.env.APP_PORT || 8080), '0.0.0.0');
