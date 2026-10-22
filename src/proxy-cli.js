#!/usr/bin/env node
import { loadProxyConfig } from './proxy-config.js';
import { loadProxyEnv } from './proxy-env.js';
import { serve } from './serve.js';
const [source, ...flags] = process.argv.slice(2);
try {
  if (!source || (source.startsWith('--') && source !== '--env') || flags.some(f => f !== '--apply') || flags.length > 1) {
    throw Error('Usage: node src/proxy-cli.js <config.json|--env> [--apply]');
  }
  const config = source === '--env' ? loadProxyEnv() : await loadProxyConfig(source);
  const cancel = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => cancel.abort());
  console.log(JSON.stringify(await serve(config, { apply: flags.includes('--apply'), signal: cancel.signal })));
} catch (e) { console.error(e.message); process.exitCode = 1; }
