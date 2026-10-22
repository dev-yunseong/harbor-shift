import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { parseDocument } from 'yaml';
import { validate } from './config.js';
import { loadSource } from './service-source.js';

export async function loadProxyConfig(file, runner) {
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error('Configuration exceeds 1 MiB');
  let raw;
  try {
    if (['.yml', '.yaml'].includes(extname(file).toLowerCase())) {
      const doc = parseDocument(text, { uniqueKeys: true, schema: 'core' });
      if (doc.errors.length || doc.warnings.length) throw Error('Invalid YAML');
      raw = doc.toJS({ maxAliasCount: 20 });
    } else raw = JSON.parse(text);
  } catch { throw Error('Invalid configuration syntax (details redacted)'); }
  if (raw?.resolvedSlots !== undefined) throw Error('resolvedSlots is an internal field');
  if (raw?.source !== undefined || raw?.slots !== undefined) raw = await resolveSources(raw, dirname(file), runner);
  return validateProxyConfig(raw, dirname(file));
}

function shutdownPolicy(s) {
  if (!s?.mode) return s;
  if (!['docker','http'].includes(s.mode)) throw Error('shutdown.mode must be docker or http');
  for (const key of Object.keys(s)) if (!['mode','request','completion','onFailure'].includes(key)) throw Error(`Unsupported shutdown field: ${key}`);
  if (s.mode === 'docker') {
    if (s.request || (s.completion && s.completion.type !== 'proxy')) throw Error('Docker shutdown waits for proxy completion');
    return { completion: s.completion || { type:'proxy' }, onFailure:s.onFailure || 'keep-old' };
  }
  if (!s.request || typeof s.request !== 'object' || Array.isArray(s.request)) throw Error('HTTP shutdown requires request');
  if ('type' in s.request) throw Error('shutdown.request does not accept type');
  return { initiate:{type:'http',method:'POST',timeoutMs:10000,...s.request}, completion:s.completion || {type:'exit'}, onFailure:s.onFailure || 'keep-old' };
}

export async function resolveSources(raw, baseDir, runner) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Configuration must be an object');
  const fields=['enabled','group','source','slots','network','dockerContext','stateDir','appPort','listenPort','readinessPath','readinessStatus','timing','proxyRequestMs','shutdown','pullPolicy'];
  for(const key of Object.keys(raw)) if(!fields.includes(key)) throw Error(`Unsupported source configuration field: ${key}`);
  if(raw.source !== undefined && raw.slots !== undefined) throw Error('Choose shared source or per-slot sources');
  if(raw.slots) {
    if(typeof raw.slots !== 'object' || Array.isArray(raw.slots) || Object.keys(raw.slots).some(k=>!['blue','green'].includes(k)) || !raw.slots.blue || !raw.slots.green) throw Error('Define both blue and green slots');
  }
  const sources={};
  for(const color of ['blue','green']) {
    const slot=raw.slots?.[color];
    if(slot && (typeof slot !== 'object' || Array.isArray(slot) || Object.keys(slot).some(k=>!['source','appPort'].includes(k)))) throw Error('Slot accepts source and appPort only');
    if(raw.source && color==='green') sources[color]=sources.blue;
    else sources[color]=await loadSource(raw.source || slot?.source,baseDir,runner);
  }
  if(sources.blue.image !== sources.green.image) throw Error('Blue and green must watch the same image reference to avoid repeated swaps');
  const network=raw.network ?? sources.blue.network ?? sources.green.network;
  if (['host','none'].includes(network)) throw Error('Source requires a bridge network');
  for(const s of Object.values(sources)) if(s.network && s.network !== network) throw Error('Both source networks must match the updater network');
  const slots={};
  for(const color of ['blue','green']) {
    const s=sources[color], ports=[...new Set(s.ports)];
    const appPort=raw.slots?.[color]?.appPort ?? raw.appPort ?? (ports.length===1?ports[0]:undefined);
    if(!Number.isSafeInteger(appPort) || appPort<1 || appPort>65535) throw Error('Set appPort when the source has no single TCP target port');
    const name=`${raw.group}-${color}`;
    slots[color]={name,url:`http://${name}:${appPort}`,publish:[],memory:s.memory || '256m',cpus:s.cpus ?? 1,container:s.container};
    if(s.openStdin !== undefined) slots[color].openStdin=s.openStdin;
  }
  const stopSeconds=raw.timing?.stopSeconds ?? 120;
  const {source, slots:inputSlots, ...rest}=raw;
  return {...rest, enabled:raw.enabled ?? true, stateDir:raw.stateDir ?? '/state',network,image:sources.blue.image,
    appPort:raw.appPort ?? Number(new URL(slots.blue.url).port || 80), listenPort:raw.listenPort ?? 8080, readinessPath:raw.readinessPath ?? '/',
    timing:{drainMs:3600000,stopSeconds,commandMs:Math.max(120000,stopSeconds*1000+30000),...raw.timing},
    proxyRequestMs:raw.proxyRequestMs ?? Math.max(1000,raw.timing?.drainMs ?? 3600000),
    shutdown:shutdownPolicy(raw.shutdown || {mode:'docker'}), resolvedSlots:slots};
}

export function validateProxyConfig(raw, baseDir = process.cwd()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Configuration must be an object');
  const allowed = ['enabled', 'group', 'image', 'network', 'dockerContext', 'stateDir', 'appPort', 'listenPort', 'readinessPath', 'readinessStatus', 'envFile', 'memory', 'cpus', 'timing', 'proxyRequestMs', 'shutdown', 'openStdin', 'pullPolicy', 'resolvedSlots'];
  for (const field of Object.keys(raw)) if (!allowed.includes(field)) throw Error(`Unsupported proxy configuration field: ${field}`);
  if (raw.enabled !== true) throw Error('Proxy management requires explicit enabled: true');
  for (const field of ['appPort', 'listenPort']) if (!Number.isSafeInteger(raw[field]) || raw[field] < 1 || raw[field] > 65535) throw Error(`Invalid ${field}`);
  if (typeof raw.readinessPath !== 'string' || !/^\/(?!\/)[^\s#]*$/.test(raw.readinessPath)) throw Error('readinessPath must be a relative HTTP path');
  const status = raw.readinessStatus ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 299) throw Error('readinessStatus must be 2xx');
  const requestMs = raw.proxyRequestMs ?? 300000;
  if (!Number.isSafeInteger(requestMs) || requestMs < 1000 || requestMs > 86400000) throw Error('Invalid proxyRequestMs');
  if (typeof raw.stateDir !== 'string' || !raw.stateDir) throw Error('stateDir required');
  const slots = raw.resolvedSlots || {};
  if (!raw.resolvedSlots) for (const color of ['blue', 'green']) {
    const name = `${raw.group}-${color}`;
    slots[color] = { name, url: `http://${name}:${raw.appPort}`, publish: [], memory: raw.memory, cpus: raw.cpus };
    if (raw.openStdin !== undefined) slots[color].openStdin = raw.openStdin;
    if (raw.envFile) slots[color].envFile = resolve(baseDir, raw.envFile);
  }
  const c = validate({ group: raw.group, image: raw.image, network: raw.network, dockerContext: raw.dockerContext || 'default',
    stateDir: resolve(baseDir, raw.stateDir), controller: 'http://localhost', tokenEnv: 'UNUSED', allowHttp: true, slots,
    timing: { requestMs: 2000, readyMs: 60000, pollMs: 500, stabilizeMs: 5000, drainMs: 300000, stopSeconds: 30, commandMs: 120000, watchMs: 60000, ...raw.timing },
    ...(raw.shutdown ? { shutdown: shutdownPolicy(raw.shutdown) } : {}), ...(raw.pullPolicy ? { pullPolicy: raw.pullPolicy } : {}) });
  return { ...c, readinessPath: raw.readinessPath, readinessStatus: status, listenPort: raw.listenPort, proxyRequestMs: requestMs };
}
