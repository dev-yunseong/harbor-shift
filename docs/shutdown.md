# Configurable graceful shutdown

YAML configuration can select Docker or HTTP shutdown. See the [YAML service sources](service-sources.md) and [README examples](graceful-shutdown.md). HTTP acknowledgement and process or work completion are separate; a successful request alone does not authorize immediate termination.

Initiation, completion, and termination are separate:

`ready candidate → switch new traffic → observe health → initiate old drain → wait completion → SIGTERM → bounded SIGKILL`

Before old drain begins, switch/health failures attempt rollback. After initiation, drain may be irreversible, so no automatic reactivation occurs. Hooks target only configured, ownership-checked running slots after switching traffic. Make hooks idempotent; uncertain outcomes require inspection, not blind retries.

## Container script/exec

```json
"shutdown": {
  "initiate": { "type": "exec", "argv": ["/app/drain", "--graceful"], "timeoutMs": 5000 },
  "completion": { "type": "proxy" },
  "onFailure": "keep-old"
}
```

Runs argv inside the old container, not on the host, with no implicit shell interpolation. The executable must exist in the image. An explicitly configured shell is the operator's responsibility. Observation is bounded, but timing out Docker exec does not guarantee its process was killed inside the container. Preserve the journal and inspect before retrying. Exec output is not logged.

## HTTP

```json
"shutdown": {
  "initiate": {
    "type": "http", "method": "POST", "path": "/admin/drain",
    "headersEnv": { "Authorization": "APP_DRAIN_AUTH" },
    "body": { "mode": "graceful" }, "timeoutMs": 5000
  },
  "completion": {
    "type": "http", "path": "/admin/status",
    "headersEnv": { "Authorization": "APP_DRAIN_AUTH" }, "timeoutMs": 2000
  }
}
```

Methods are explicit POST/PUT/PATCH/DELETE, body is optional JSON. `url` optionally overrides the base URL; `{slot}` expands only to the configured container name. `path` is appended. Default base is the slot URL. Header environment values contain the full value, including any Bearer prefix. Keep secrets in the updater environment via a secret manager, never JSON.

Non-2xx, redirects, timeouts and transport errors fail the hook. No mutation retry occurs. Responses and credentials are redacted from errors. Use TLS for remote management; local HTTP is for trusted private networks only.

## Original-process stdin

```json
"openStdin": true,
"shutdown": {
  "initiate": { "type": "stdin", "data": "drain\n", "timeoutMs": 3000 },
  "completion": { "type": "exit" }
}
```

In advanced config put `openStdin` on each slot. The original process must read stdin and implement the command. This uses Docker Engine attach, not exec. Requires local Unix-socket context, `OpenStdin=true`, `Tty=false`, `StdinOnce=false`. Unsupported settings fail clearly. TTY consoles, Windows named pipes, SSH/TCP Docker contexts, and exec-created process stdin are unsupported.

A successful write is not application acknowledgement or completion. Use a separate completion check. Validate attach-disconnect semantics with your application; the tool does not deliberately send EOF as a shutdown command.

## Completion and deadlines

| Type | Completion condition |
|---|---|
| `proxy` | Bundled mode: old HTTP requests and WebSocket tunnels closed |
| `http` | GET returns `{"draining":true,"sessions":0}`; nonnegative integer; bundled mode also requires proxy count zero |
| `exit` | Wait for original container process to exit |
| `adapter` | Advanced adapter's default `/status` contract |

Without an override, bundled mode counts proxy traffic; advanced mode uses its status API. Without initiation config, bundled mode excludes old new traffic through the proxy, while advanced mode calls its default drain API. Applications that exit prematurely cannot retain connections.

Initiation timeout is 1..300000 ms. `timing.drainMs` bounds completion waiting after initiation. Final `stopSeconds` gives SIGTERM grace before Docker SIGKILL. Deadline escalation may disconnect clients and lose work. Container exit is independently checked.

## Failure policy

`keep-old` (default) preserves the old process and journal on initiation failure. New traffic stays on the candidate; bundled polling pauses while the proxy keeps serving. It does not route new work back to a possibly draining old instance.

Explicit `force-stop` skips completion after initiation failure and proceeds to bounded stop, potentially losing work. Completion/status errors still pause for review. Successful initiation followed by drain deadline triggers bounded stop under either policy.

Hooks are trusted operator configuration, never taken from untrusted labels. Do not place secrets in exec arguments or stdin data. [Recovery →](operations.md)
