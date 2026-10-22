# Bundled proxy mode

The default Compose file configures the updater through environment variables and pulls the GHCR image containing the Docker CLI, an HTTP/1.1 reverse proxy, WebSocket tunneling, and polling. No management API is exposed. One config explicitly opts in one service; the tool never discovers and adopts arbitrary labeled containers.

## Optional JSON configuration

The default setup uses [environment variables](environment.md). The following schema is for explicit JSON configuration; see the [advanced guide](json-config.md).

```json
{
  "enabled": true,
  "group": "my-web",
  "image": "example.invalid/team/web:stable",
  "network": "harbor-demo",
  "stateDir": "/state",
  "appPort": 8080,
  "listenPort": 8080,
  "readinessPath": "/health/ready",
  "readinessStatus": 200,
  "memory": "256m",
  "cpus": 1,
  "timing": { "watchMs": 60000, "drainMs": 300000, "stopSeconds": 30 }
}
```

The image supplies its command, entrypoint and user. Readiness requires exactly the configured status (default 200); redirects fail. Unknown config fields fail validation. The updater creates `<group>-blue/green` with ownership labels, resource caps, no-new-privileges, dropped capabilities, `restart=no`, and no host ports. Both slots and the updater must join the configured existing bridge network.

Images declaring Docker volumes are rejected. Shared volumes, host networking, privileged mode, arbitrary Docker flags, command overrides, and Compose service cloning are unsupported. Use a stateless image and a non-root image USER.

| Additional option | Meaning |
|---|---|
| `dockerContext` | Existing context, default `default` |
| `envFile` | Optional file inside updater, mounted read-only by operator; relative to config |
| `openStdin` | Create slots with original-process stdin open, no TTY |
| `shutdown` | [Initiation, completion, and failure policy](shutdown.md) |
| `proxyRequestMs` | Upstream HTTP inactivity limit, default 300000 ms; not a WebSocket lifetime limit |
| `pullPolicy` | `always` by default; `never` compares local images without registry access, for CI/offline use |
| `timing` | [Lifecycle deadlines](integration.md); partial overrides supported |

Registry credentials are an operator responsibility. Mount an existing, dedicated Docker CLI configuration read-only when needed. No credentials are generated. The daemon must be able to pull the selected images.

Environment configuration is documented in [환경변수 설정](environment.md). Use `--env --apply` for environment mode or an explicit JSON file argument for JSON mode; the two sources are not merged. Environment mode defaults to a one-hour drain and 120-second stop grace; JSON defaults remain unchanged.

## Lifecycle

1. Hold one state-directory lock for the entire updater lifetime.
2. On first start, require no existing owned slots; start blue, check readiness, persist its route, then listen.
3. Poll image changes, start the inactive slot, check readiness, switch new traffic, and observe health.
4. Initiate optional drain, wait for old requests/tunnels plus any application completion check, then stop the old slot.

Each new HTTP request selects the current backend, even on a reused client keep-alive connection. Existing requests and upgraded WebSockets retain their selected backend. HTTP/2, HTTP/3, CONNECT, arbitrary TCP/UDP and TLS termination are not implemented. Terminate TLS in front. Forwarded headers describe the immediate peer; no trusted proxy-chain policy is implemented.

Proxy counts do not prove that background jobs, queues, or writes after client cancellation have completed. Use application status hooks for those. Database compatibility and reconnect/resume remain application responsibilities.

## Stop and recovery

Updater SIGTERM finishes the current bounded deployment, stops polling, then closes proxy connections. Restarting/upgrading the updater itself interrupts connections; there is no proxy HA or self-update. Set Compose stop grace longer than your lifecycle deadlines. The environment-based example uses 90 minutes to cover the default one-hour drain plus deployment and stop operations. Increase it when extending lifecycle deadlines.

After a failed deployment, updates pause but the current route keeps serving. Inspect `updates_paused` logs; do not blindly restart. A pending transaction, stale hard-kill lock, missing state with existing slots, or inconsistent running slots blocks startup until [reconciliation](operations.md). Normal updater stops leave app slots running and route state persistent. A clean restart validates them before listening.

One updater, unique group, dedicated state volume, no competing Watchtower/Compose writer. No live config reload. Changing the service definition requires reviewing existing containers/state and application compatibility; the tool does not safely reinterpret an arbitrary old service just because `image` changed.

`docker compose down` stops the updater but leaves dynamically created slots; the network may remain in use. After stopping traffic and verifying the exact group, remove only that group's blue/green containers, then bring Compose down. Retain state unless deliberately resetting. Do not use broad prune commands.

## Preview and validation

`node src/proxy-cli.js examples/proxy/service.json` is a no-side-effect plan. The image also defaults to dry-run; sample Compose explicitly supplies `--apply`.

`npm test` runs local tests. On a disposable Linux Docker host only, `HARBOR_DOCKER_TEST=1 node --test --test-concurrency=1 integration/*.test.js` exercises uniquely named real containers with deadlines and ownership-checked cleanup. Images are built locally, never published. Private registry authentication is outside these tests.

[Verified CI run](https://github.com/dev-yunseong/harbor-shift/actions/runs/39266244366): both real Docker scenarios passed, including the bundled updater's HTTP/WebSocket retention, stdin drain, graceful retirement, and unhealthy-update preservation. The run also passed 32 unit/fixture tests on Linux and Windows.
