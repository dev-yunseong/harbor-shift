# Configuration and integration contract

The checked-in JSON is a placeholder, not a production target. Paths are relative to the config file. Unknown fields fail validation. `plan` and `once` without `--apply` validate configuration but do not discover remote state or authenticate.

| Field | Meaning |
|---|---|
| `group` | Exclusive ownership namespace, lowercase letters/digits/hyphens |
| `image` | Registry reference to poll; preferably a controlled tag or digest |
| `dockerContext` | Explicit existing Docker CLI context; never inferred from ambient selection |
| `network` | Existing bridge network; not created by the deployer |
| `stateDir` | Persistent local directory unique to this service; share between all invocations |
| `controller` | Admission controller base URL |
| `tokenEnv` | Environment variable containing the management bearer token |
| `allowHttp` | Explicit opt-in for trusted local HTTP only |
| `slots.blue/green` | Distinct container names and management URLs |
| `envFile` | Optional private Docker env file; never commit it |
| `publish` | Loopback TCP port mappings only; use a private network for remote management |
| `memory`, `cpus` | Explicit resource caps for each slot |

All timing fields are positive integer milliseconds except `stopSeconds`. `readyMs` bounds readiness polling, `stabilizeMs` observes the candidate after switching, `drainMs` bounds the session wait after drain acknowledgement, `pollMs` spaces probes, and `watchMs` separates completed deployments. Every HTTP call has `requestMs`; every Docker subprocess has `commandMs`, which must exceed shutdown grace. A lifecycle phase may exceed its polling window by an in-progress Docker command; these are bounded operations, not a hard end-to-end deadline. Watch exits on its first failure; supervisors must not blindly restart it in a tight loop.

## HTTP adapter v1

All requests carry `Authorization: Bearer <token>`. All successful responses are 2xx JSON, under 16 KiB. Redirects are rejected. The controller is your lobby/router's admission authority, **not included as a production server**.

| Endpoint | Response / behavior |
|---|---|
| Controller `GET /route` | `{"active":"blue","revision":"opaque-nonempty-string"}` |
| Controller `PUT /route` | Body `{"active":"green","expectedRevision":"..."}`; atomically compare-and-set, then return JSON |
| Slot `GET /ready` | `{"ready":true}` only when dependencies and application are ready |
| Slot `POST /drain` | Idempotently stop accepting new work, preserve in-flight sessions; return `{"draining":true}` |
| Slot `GET /status` | `{"draining":true,"sessions":0}`; count **all** work whose completion matters |

The controller MUST provide linearizable reads and CAS updates; every successful switch produces a new revision. Return non-2xx on revision conflicts. A successful switch acknowledgement means **all admission paths** have observed the new route. Returning success while a cache still sends new sessions to the old slot violates the contract. Integrate version acknowledgements across routers or use a single authoritative allocator. Time delays alone are not proof of convergence.

Candidates must start ready but unadvertised: starting a container must not automatically register it for new assignments. Clients must obtain allocations through the controller. Distinct slot addresses continue routing already established sessions to the original slot. Any stale/direct client attempting a new session on a draining slot must be rejected without disrupting existing sessions. Readiness must not activate admission as a side effect.

The application must stop taking new background work as part of drain and truthfully count remaining work. Drain may be irreversible; Harbor Shift does not try to reactivate an already draining slot. Handle SIGTERM in PID 1, flush durable state, and exit before the configured grace. When sessions reach zero the tool still calls Docker stop for deterministic retirement. Use `restart=no` so a drained server cannot resurrect.

## Initial setup

Bootstrap is deliberately manual. Create the network and a running blue container from the desired initial image, with labels `harbor-shift.group=<group>` and `harbor-shift.slot=blue`, and `--restart=no`. Configure the controller to blue only after readiness. Green may be absent or stopped; any existing slot must have matching labels and restart policy. The tool will not adopt unlabeled containers or recover a zero-running-slot outage automatically.

Supported creation options are intentionally narrow: one network, loopback publishes, env file, CPU/memory caps, dropped capabilities and no-new-privileges. Image command, entrypoint and user come from the image. Arbitrary Docker flags, bind mounts, Compose reconstruction, and proxy configuration are unsupported. Extend `Docker` and add tests before widening scope. `Deployer` depends on runtime/admission/store interfaces to permit future adapters.
