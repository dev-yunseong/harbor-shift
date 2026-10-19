import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export class Store {
  constructor(dir) { this.dir = dir; this.lockPath = join(dir, 'lock'); this.journalPath = join(dir, 'transaction.json'); }
  async lock() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const handle = await open(this.lockPath, 'wx', 0o600).catch(() => { throw Error('Lock unavailable; another process or stale lock requires operator review'); });
    await handle.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    await handle.sync(); await handle.close();
    return () => unlink(this.lockPath);
  }
  async pending() {
    try { return JSON.parse(await readFile(this.journalPath, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async begin(data) {
    const h = await open(this.journalPath, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify(data, null, 2)); await h.sync(); } finally { await h.close(); }
  }
  async complete() { await unlink(this.journalPath); }
}
