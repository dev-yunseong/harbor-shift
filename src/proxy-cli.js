#!/usr/bin/env node
import { loadProxyConfig } from './proxy-config.js';
import { serve } from './serve.js';
const [file, ...flags] = process.argv.slice(2);
try {
  if (!file || flags.some(f => f !== '--apply')) throw Error('Usage: node src/proxy-cli.js config.json [--apply]');
  const cancel = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => cancel.abort());
  console.log(JSON.stringify(await serve(await loadProxyConfig(file), { apply: flags.includes('--apply'), signal: cancel.signal })));
} catch (e) { console.error(e.message); process.exitCode = 1; }
