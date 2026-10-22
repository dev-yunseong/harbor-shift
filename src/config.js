import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { validateContainer } from './service-source.js';
import { validateShutdown } from './shutdown.js';

const id = /^[a-z][a-z0-9-]{0,47}$/;
function keys(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`Unknown ${name} field: ${key}`);
}
export function validate(c) {
  keys(c, ['group', 'image', 'dockerContext', 'network', 'stateDir', 'controller', 'tokenEnv', 'allowHttp', 'slots', 'timing', 'shutdown', 'pullPolicy'], 'config');
  if (c.pullPolicy !== undefined && !['always', 'never'].includes(c.pullPolicy)) throw Error('pullPolicy must be always or never');
  validateShutdown(c.shutdown);
  for (const k of ['group', 'dockerContext', 'network']) if (!id.test(c[k] || '')) throw Error(`Invalid ${k}`);
  if (typeof c.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(c.image)) throw Error('Invalid image');
  if (typeof c.stateDir !== 'string' || !c.stateDir) throw Error('stateDir required');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(c.tokenEnv || '')) throw Error('tokenEnv required');
  if (c.allowHttp !== undefined && typeof c.allowHttp !== 'boolean') throw Error('allowHttp must be boolean');
  function url(value) {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || !['http:', 'https:'].includes(u.protocol)) throw Error('Invalid endpoint URL');
    if (u.protocol !== 'https:' && !c.allowHttp) throw Error('HTTP requires allowHttp: true');
  }
  url(c.controller);
  keys(c.slots, ['blue', 'green'], 'slots');
  for (const color of ['blue', 'green']) {
    const s = c.slots[color];
    keys(s, ['name', 'url', 'envFile', 'publish', 'memory', 'cpus', 'openStdin', 'container'], `slot ${color}`);
    validateContainer(s.container);
    if (s.openStdin !== undefined && typeof s.openStdin !== 'boolean') throw Error('openStdin must be boolean');
    if (!id.test(s.name || '')) throw Error('Invalid slot name');
    url(s.url);
    if (s.envFile !== undefined && (typeof s.envFile !== 'string' || !s.envFile)) throw Error('Invalid envFile');
    if (!Array.isArray(s.publish) || s.publish.some(p => !/^127\.0\.0\.1:\d{1,5}:\d{1,5}$/.test(p))) throw Error('publish must contain loopback TCP mappings');
    if (!/^[1-9]\d*[mg]$/.test(s.memory || '') || typeof s.cpus !== 'number' || !Number.isFinite(s.cpus) || s.cpus <= 0) throw Error('Explicit memory and cpus required');
  }
  if (c.slots.blue.name === c.slots.green.name || c.slots.blue.url === c.slots.green.url) throw Error('Slots must have distinct names and URLs');
  if (c.shutdown?.initiate?.type === 'stdin' && Object.values(c.slots).some(s => s.openStdin !== true)) throw Error('stdin initiation requires openStdin: true for both slots');
  keys(c.timing, ['requestMs', 'readyMs', 'pollMs', 'stabilizeMs', 'drainMs', 'stopSeconds', 'commandMs', 'watchMs'], 'timing');
  for (const k of ['requestMs', 'readyMs', 'pollMs', 'stabilizeMs', 'drainMs', 'stopSeconds', 'commandMs', 'watchMs']) {
    if (!Number.isSafeInteger(c.timing[k]) || c.timing[k] < 1 || c.timing[k] > 86400000) throw Error(`Invalid timing.${k}`);
  }
  if (c.timing.stopSeconds > 3600 || c.timing.commandMs <= c.timing.stopSeconds * 1000) throw Error('commandMs must exceed stop grace; grace <= 3600 seconds');
  if (c.timing.watchMs < 1000) throw Error('watchMs must be >= 1000');
  return c;
}
export async function loadConfig(path) {
  const c = validate(JSON.parse(await readFile(path, 'utf8')));
  if (c.shutdown?.completion?.type === 'proxy') throw Error('Proxy completion requires bundled proxy mode');
  c.stateDir = resolve(dirname(path), c.stateDir);
  for (const s of Object.values(c.slots)) if (s.envFile) s.envFile = resolve(dirname(path), s.envFile);
  return c;
}
