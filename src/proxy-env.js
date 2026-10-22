import { validateProxyConfig } from './proxy-config.js';

// 환경변수도 JSON과 같은 검증을 거쳐 컨테이너 생성 계약을 유지한다.
export function loadProxyEnv(env = process.env) {
  const allowed = new Set(`ENABLED GROUP IMAGE NETWORK STATE_DIR DOCKER_CONTEXT APP_PORT LISTEN_PORT
    READINESS_PATH READINESS_STATUS MEMORY CPUS PULL_POLICY PROXY_REQUEST_MS REQUEST_MS READY_MS POLL_MS
    STABILIZE_MS DRAIN_MS STOP_SECONDS COMMAND_MS WATCH_MS APP_ENV_FILE SHUTDOWN_MODE COMPLETION ON_FAILURE
    HTTP_PATH HTTP_URL HTTP_METHOD HTTP_TIMEOUT_MS HTTP_AUTHORIZATION HTTP_STATUS_PATH HTTP_STATUS_TIMEOUT_MS`.split(/\s+/));
  for (const key of Object.keys(env)) {
    if (key.startsWith('HARBOR_') && !allowed.has(key.slice(7))) throw Error(`Unknown environment setting: ${key}`);
  }
  const value = (name, fallback) => env[`HARBOR_${name}`] ?? fallback;
  const integer = (name, fallback) => {
    const raw = value(name, String(fallback));
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw Error(`Invalid HARBOR_${name}`);
    return Number(raw);
  };
  const choice = (name, fallback, choices) => {
    const raw = value(name, fallback);
    if (!choices.includes(raw)) throw Error(`Invalid HARBOR_${name}`);
    return raw;
  };
  const stopSeconds = integer('STOP_SECONDS', 120);
  const drainMs = integer('DRAIN_MS', 3600000);
  const raw = {
    enabled: choice('ENABLED', 'false', ['true', 'false']) === 'true',
    group: value('GROUP'), image: value('IMAGE'), network: value('NETWORK'),
    stateDir: value('STATE_DIR', '/state'), dockerContext: value('DOCKER_CONTEXT', 'default'),
    appPort: integer('APP_PORT', 8080), listenPort: integer('LISTEN_PORT', 8080),
    readinessPath: value('READINESS_PATH', '/'), readinessStatus: integer('READINESS_STATUS', 200),
    memory: value('MEMORY', '256m'), cpus: Number(value('CPUS', '1')),
    pullPolicy: choice('PULL_POLICY', 'always', ['always', 'never']),
    proxyRequestMs: integer('PROXY_REQUEST_MS', Math.max(1000, drainMs)),
    timing: {
      requestMs: integer('REQUEST_MS', 2000), readyMs: integer('READY_MS', 60000),
      pollMs: integer('POLL_MS', 500), stabilizeMs: integer('STABILIZE_MS', 5000),
      drainMs, stopSeconds,
      commandMs: integer('COMMAND_MS', Math.max(120000, stopSeconds * 1000 + 30000)),
      watchMs: integer('WATCH_MS', 60000)
    }
  };
  if (value('APP_ENV_FILE') !== undefined) raw.envFile = value('APP_ENV_FILE');
  const mode = choice('SHUTDOWN_MODE', 'docker', ['docker', 'http']);
  const httpFields = ['HTTP_PATH', 'HTTP_URL', 'HTTP_METHOD', 'HTTP_TIMEOUT_MS', 'HTTP_AUTHORIZATION', 'HTTP_STATUS_PATH', 'HTTP_STATUS_TIMEOUT_MS'];
  if (mode === 'docker' && httpFields.some(name => value(name) !== undefined)) throw Error('HTTP settings require HARBOR_SHUTDOWN_MODE=http');
  const completion = choice('COMPLETION', mode === 'http' ? 'exit' : 'proxy', mode === 'http' ? ['exit', 'http', 'proxy'] : ['proxy']);
  const onFailure = choice('ON_FAILURE', 'keep-old', ['keep-old', 'force-stop']);
  raw.shutdown = { completion: { type: completion }, onFailure };
  if (mode === 'http') {
    const shared = {};
    if (value('HTTP_URL') !== undefined) shared.url = value('HTTP_URL');
    if (value('HTTP_AUTHORIZATION') !== undefined) {
      if (!value('HTTP_AUTHORIZATION')) throw Error('HARBOR_HTTP_AUTHORIZATION must not be empty');
      shared.headersEnv = { Authorization: 'HARBOR_HTTP_AUTHORIZATION' };
    }
    raw.shutdown.initiate = { type: 'http', ...shared, path: value('HTTP_PATH'),
      method: choice('HTTP_METHOD', 'POST', ['POST', 'PUT', 'PATCH', 'DELETE']),
      timeoutMs: integer('HTTP_TIMEOUT_MS', 10000) };
    if (completion === 'http') raw.shutdown.completion = { type: 'http', ...shared,
      path: value('HTTP_STATUS_PATH'), timeoutMs: integer('HTTP_STATUS_TIMEOUT_MS', 2000) };
    else if (value('HTTP_STATUS_PATH') !== undefined || value('HTTP_STATUS_TIMEOUT_MS') !== undefined) throw Error('HTTP status settings require HARBOR_COMPLETION=http');
  }
  return validateProxyConfig(raw);
}
