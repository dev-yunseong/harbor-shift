import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { validate } from './config.js';

export async function loadProxyConfig(file) {
  return validateProxyConfig(JSON.parse(await readFile(file, 'utf8')), dirname(file));
}

export function validateProxyConfig(raw, baseDir = process.cwd()) {
  const allowed = ['enabled', 'group', 'image', 'network', 'dockerContext', 'stateDir', 'appPort', 'listenPort', 'readinessPath', 'readinessStatus', 'envFile', 'memory', 'cpus', 'timing', 'proxyRequestMs', 'shutdown', 'openStdin', 'pullPolicy'];
  for (const field of Object.keys(raw)) if (!allowed.includes(field)) throw Error(`Unsupported proxy configuration field: ${field}`);
  if (raw.enabled !== true) throw Error('Proxy management requires explicit enabled: true');
  for (const field of ['appPort', 'listenPort']) if (!Number.isSafeInteger(raw[field]) || raw[field] < 1 || raw[field] > 65535) throw Error(`Invalid ${field}`);
  if (typeof raw.readinessPath !== 'string' || !/^\/(?!\/)[^\s#]*$/.test(raw.readinessPath)) throw Error('readinessPath must be a relative HTTP path');
  const status = raw.readinessStatus ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 299) throw Error('readinessStatus must be 2xx');
  const requestMs = raw.proxyRequestMs ?? 300000;
  if (!Number.isSafeInteger(requestMs) || requestMs < 1000 || requestMs > 86400000) throw Error('Invalid proxyRequestMs');
  if (typeof raw.stateDir !== 'string' || !raw.stateDir) throw Error('stateDir required');
  const slots = {};
  for (const color of ['blue', 'green']) {
    const name = `${raw.group}-${color}`;
    slots[color] = { name, url: `http://${name}:${raw.appPort}`, publish: [], memory: raw.memory, cpus: raw.cpus };
    if (raw.openStdin !== undefined) slots[color].openStdin = raw.openStdin;
    if (raw.envFile) slots[color].envFile = resolve(baseDir, raw.envFile);
  }
  const c = validate({ group: raw.group, image: raw.image, network: raw.network, dockerContext: raw.dockerContext || 'default',
    stateDir: resolve(baseDir, raw.stateDir), controller: 'http://localhost', tokenEnv: 'UNUSED', allowHttp: true, slots,
    timing: { requestMs: 2000, readyMs: 60000, pollMs: 500, stabilizeMs: 5000, drainMs: 300000, stopSeconds: 30, commandMs: 120000, watchMs: 60000, ...raw.timing },
    ...(raw.shutdown ? { shutdown: raw.shutdown } : {}), ...(raw.pullPolicy ? { pullPolicy: raw.pullPolicy } : {}) });
  return { ...c, readinessPath: raw.readinessPath, readinessStatus: status, listenPort: raw.listenPort, proxyRequestMs: requestMs };
}
