import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
const exec = promisify(execFile);

function object(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`Invalid ${name}`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error(`Unsupported ${name} field: ${key}`);
}
const string = value => typeof value === 'string' && !value.includes('\0');

// 명령을 shell에서 실행하지 않고 argv로만 해석한다. 변수 치환과 파이프는 지원하지 않는다.
export function splitCommand(input) {
  if (Array.isArray(input)) {
    if (!input.length || input.some(x => !string(x))) throw Error('Command argv must contain strings');
    return [...input];
  }
  if (!string(input)) throw Error('Command must be a string or argv array');
  const args = []; let word = '', quote = '', started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote === "'") { if (c === "'") quote = ''; else word += c; started = true; continue; }
    if (c === '\\') {
      if (++i >= input.length) throw Error('Incomplete command escape');
      if (input[i] !== '\n') { word += input[i]; started = true; }
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else { if (c === '$' || c === '`') throw Error('Shell expansion is unsupported'); word += c; }
      started = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { args.push(word); word = ''; started = false; } }
    else { if (/[;&|<>$`]/.test(c)) throw Error('Shell operators and expansion are unsupported'); word += c; started = true; }
  }
  if (quote) throw Error('Unclosed command quote');
  if (started) args.push(word);
  return args;
}

function environment(value) {
  if (!string(value)) throw Error('Invalid application environment');
  const at = value.indexOf('='), name = at < 0 ? value : value.slice(0, at);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw Error('Invalid application environment name');
  if (at >= 0) return value;
  if (process.env[name] === undefined) throw Error('Application environment variable is missing');
  return `${name}=${process.env[name]}`;
}
function port(value) {
  const text = String(value);
  if (!/^\d+(\/tcp)?$/.test(text)) throw Error('Only single TCP target ports are supported');
  const p = Number(text.split('/')[0]);
  if (p < 1 || p > 65535) throw Error('Invalid target port');
  return p;
}
function memory(value) {
  // Compose가 bytes로 정규화한 메모리 제한도 기존 m 단위로 바꾼다.
  if (/^\d+$/.test(String(value))) {
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes) || bytes < 1048576 || bytes % 1048576) throw Error('Memory must be a whole number of MiB');
    return `${bytes / 1048576}m`;
  }
  return String(value).toLowerCase().replace(/ib$|b$/, '');
}
function mount(source, target) {
  if (!string(source) || !source.startsWith('/') || !string(target) || !target.startsWith('/') || source.includes(',') || target.includes(',')) throw Error('Read-only bind mounts require absolute Linux paths without commas');
  return { source, target };
}
export function validateContainer(c) {
  if (c === undefined) return;
  object(c, ['env', 'envFiles', 'command', 'entrypoint', 'user', 'workdir', 'mounts', 'labels', 'readOnly', 'init'], 'container');
  for (const field of ['env', 'envFiles', 'command', 'entrypoint']) if (c[field] !== undefined && (!Array.isArray(c[field]) || c[field].some(x => !string(x)))) throw Error(`Invalid container ${field}`);
  if (c.env?.some(x => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x))) throw Error('Invalid container environment');
  for (const field of ['user', 'workdir']) if (c[field] !== undefined && !string(c[field])) throw Error(`Invalid container ${field}`);
  for (const field of ['readOnly', 'init']) if (c[field] !== undefined && typeof c[field] !== 'boolean') throw Error(`Invalid container ${field}`);
  if (c.mounts !== undefined) {
    if (!Array.isArray(c.mounts)) throw Error('Invalid container mounts');
    for (const m of c.mounts) { object(m, ['source', 'target'], 'mount'); mount(m.source, m.target); }
  }
  if (c.labels !== undefined) {
    object(c.labels, Object.keys(c.labels), 'labels');
    for (const [key, value] of Object.entries(c.labels)) if (!string(value) || key.startsWith('harbor-shift.') || key.startsWith('com.docker.compose.') || key === 'com.centurylinklabs.watchtower.enable') throw Error('Reserved or invalid container label');
  }
}

export function parseDockerRun(command, baseDir) {
  const argv = splitCommand(command);
  if (argv.shift() !== 'docker') throw Error('Expected docker run command');
  if (argv[0] === 'container') argv.shift();
  if (argv.shift() !== 'run') throw Error('Expected docker run command');
  const result = { ports: [], container: { env: [], envFiles: [], mounts: [], labels: {} } }, c = result.container;
  const once = new Set();
  while (argv.length) {
    let option = argv.shift();
    if (option === '--') { result.image = argv.shift(); break; }
    if (!option.startsWith('-')) { result.image = option; break; }
    if (['-d', '--detach', '--rm'].includes(option)) continue;
    if (['-i', '--interactive'].includes(option)) { result.openStdin = true; continue; }
    if (option === '--read-only') { c.readOnly = true; continue; }
    if (option === '--init') { c.init = true; continue; }
    const equal = option.indexOf('=');
    const supplied = equal >= 0 ? option.slice(equal + 1) : undefined;
    if (equal >= 0) option = option.slice(0, equal);
    const repeated = ['-e','--env','--env-file','-p','--publish','--expose','-v','--volume','--mount','-l','--label'];
    const supported = [...repeated,'--name','--restart','--network','--net','-m','--memory','--cpus','--entrypoint','-u','--user','-w','--workdir'];
    if (!supported.includes(option)) throw Error('Unsupported docker run option; see source documentation');
    const value = supplied ?? argv.shift();
    if (value === undefined || value === '') throw Error('Docker run option requires a value');
    const canonical = ({'--net':'--network','-m':'--memory','-u':'--user','-w':'--workdir'})[option] || option;
    if (!repeated.includes(option)) { if (once.has(canonical)) throw Error('Duplicate docker run option'); once.add(canonical); }
    if (['-e','--env'].includes(option)) c.env.push(environment(value));
    else if (option === '--env-file') c.envFiles.push(resolve(baseDir, value));
    else if (['-p','--publish'].includes(option)) {
      if (!/^(?:(?:\d{1,3}\.){3}\d{1,3}:)?(?:\d+:)?\d+(?:\/tcp)?$/.test(value)) throw Error('Unsupported port mapping');
      result.ports.push(port(value.split(':').at(-1)));
    } else if (option === '--expose') result.ports.push(port(value));
    else if (['--network','--net'].includes(option)) result.network = value;
    else if (['--memory','-m'].includes(option)) result.memory = memory(value);
    else if (option === '--cpus') result.cpus = Number(value);
    else if (option === '--entrypoint') c.entrypoint = [value];
    else if (['--user','-u'].includes(option)) c.user = value;
    else if (['--workdir','-w'].includes(option)) c.workdir = value;
    else if (['--volume','-v'].includes(option)) {
      const parts = value.split(':');
      if (parts.length !== 3 || parts[2] !== 'ro') throw Error('Only read-only bind mounts are supported');
      c.mounts.push(mount(parts[0], parts[1]));
    } else if (option === '--mount') {
      const parts = value.split(','), opts = Object.fromEntries(parts.map(x => { const i=x.indexOf('='); return i<0?[x,true]:[x.slice(0,i),x.slice(i+1)]; }));
      if (parts.length !== Object.keys(opts).length || Object.keys(opts).some(x=>!['type','src','source','dst','target','destination','readonly','ro'].includes(x)) || opts.type !== 'bind' || !(opts.readonly === true || opts.ro === true)) throw Error('Only read-only bind mounts are supported');
      c.mounts.push(mount(opts.src ?? opts.source, opts.dst ?? opts.target ?? opts.destination));
    } else if (['--label','-l'].includes(option)) {
      const at=value.indexOf('='); if(at<1) throw Error('Label must be key=value'); c.labels[value.slice(0,at)]=value.slice(at+1);
    }
    // name, restart, detach, rm은 슬롯의 이름과 종료 정책으로 대체한다.
  }
  if (!result.image) throw Error('Docker run image is required');
  if (argv.length) c.command = argv;
  if (['host','none'].includes(result.network)) throw Error('Source requires a bridge network');
  validateContainer(c);
  return result;
}

export function parseCompose(model, service) {
  const names = Object.keys(model.services || {});
  if (!service && names.length !== 1) throw Error('Compose source.service is required when multiple services exist');
  const s = model.services?.[service || names[0]];
  if (!s) throw Error('Compose service not found');
  object(s, ['image','container_name','restart','ports','expose','environment','env_file','command','entrypoint','user','working_dir','read_only','init','stdin_open','tty','mem_limit','cpus','networks','volumes','labels','profiles'], 'Compose service');
  if (s.tty) throw Error('TTY services are unsupported');
  const c = { env: [], envFiles: [], mounts: [], labels: {} };
  const result = { image:s.image, ports:[], container:c };
  if(s.mem_limit !== undefined) result.memory=memory(s.mem_limit);
  if(s.cpus !== undefined) result.cpus=Number(s.cpus);
  if(s.stdin_open !== undefined) result.openStdin=s.stdin_open;
  if(s.environment) for(const [k,v] of Object.entries(s.environment)) c.env.push(environment(v === null ? k : `${k}=${v}`));
  if(s.env_file?.length) throw Error('Compose env_file must be resolved by docker compose config');
  for(const p of s.ports || []) {
    object(p,['target','published','host_ip','protocol','mode','name','app_protocol'],'Compose port');
    if(p.protocol && p.protocol!=='tcp') throw Error('Only TCP services are supported');
    result.ports.push(port(p.target));
  }
  for(const p of s.expose || []) result.ports.push(port(p));
  if(s.networks) {
    const networks=Object.keys(s.networks);
    if(networks.length!==1) throw Error('Source requires exactly one bridge network');
    const options=s.networks[networks[0]];
    if(options && Object.keys(options).length) throw Error('Compose network aliases and per-service network options are unsupported');
    const definition=model.networks?.[networks[0]];
    if(definition?.driver && definition.driver!=='bridge') throw Error('Only bridge networks are supported');
    result.network=definition?.name || networks[0];
  }
  for(const v of s.volumes || []) {
    object(v,['type','source','target','read_only','bind'],'Compose volume');
    if(v.type!=='bind' || v.read_only!==true || (v.bind && Object.keys(v.bind).some(k=>k!=='create_host_path'))) throw Error('Only read-only bind mounts are supported');
    c.mounts.push(mount(v.source,v.target));
  }
  for(const field of ['command','entrypoint']) if(s[field] !== undefined && s[field] !== null) c[field]=Array.isArray(s[field])?s[field]:splitCommand(s[field]);
  if(s.user !== undefined) c.user=s.user;
  if(s.working_dir !== undefined) c.workdir=s.working_dir;
  for(const [from,to] of [['read_only','readOnly'],['init','init']]) if(s[from]!==undefined) c[to]=s[from];
  c.labels=s.labels || {};
  validateContainer(c);
  return result;
}

export async function loadSource(source, baseDir, runner=exec) {
  object(source,['dockerRun','composeFile','service'],'source');
  if((source.dockerRun !== undefined) === (source.composeFile !== undefined)) throw Error('Choose exactly one dockerRun or composeFile source');
  if(source.dockerRun !== undefined) {
    if(source.service !== undefined) throw Error('source.service requires composeFile');
    return parseDockerRun(source.dockerRun,baseDir);
  }
  if(!string(source.composeFile) || !source.composeFile || (source.service !== undefined && !string(source.service))) throw Error('Invalid Compose source');
  const file=resolve(baseDir,source.composeFile);
  let model;
  try {
    const {stdout}=await runner('docker',['compose','--file',file,'config','--format','json'],{shell:false,timeout:30000,maxBuffer:4*1024*1024,windowsHide:true});
    model=JSON.parse(stdout);
  } catch { throw Error('Compose configuration failed (details redacted)'); }
  return parseCompose(model,source.service);
}
