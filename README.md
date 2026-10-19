<div align="center">

# Harbor Shift
**New containers take new work. Old containers finish what they started.**

Blue-green container updates with readiness checks, controlled admission, and bounded graceful shutdown.

[Quickstart](#quickstart) · [Integration contract](docs/integration.md) · [Operations](docs/operations.md) · [Contributing](CONTRIBUTING.md)

</div>

Harbor Shift watches a Docker image, starts the inactive slot, checks readiness, switches new work, and drains the previous slot. Failed readiness leaves the active slot alone. Switch or early health failures trigger rollback. Uncertain outcomes stop automation for operator review.

**Status:** early implementation; unit and local HTTP tests pass. Docker integration has not yet been exercised on a real engine. Validate in a disposable environment before production.

## Quickstart

Requires Node.js 24+. The demo needs no Docker or credentials.

```sh
git clone https://github.com/dev-yunseong/harbor-shift.git
cd harbor-shift
npm test
npm run demo
node src/cli.js plan examples/config.json
```

For real use, configure two dedicated slots and implement the small [admission API](docs/integration.md) in your lobby/router. Edit the example's image, Docker context, network, endpoints, and resource limits. Supply its bearer token through `HARBOR_TOKEN` using your secret manager.

```sh
# Preview only; no registry, Docker or HTTP calls
node src/cli.js once path/to/config.json

# Explicitly enable changes
node src/cli.js once path/to/config.json --apply
node src/cli.js watch path/to/config.json --apply
```

| Capability | Behavior |
|---|---|
| Updates | Pull configured image; deploy its immutable local image ID only when changed |
| Readiness | Strict JSON readiness check before admission switch |
| Draining | Stop new assignments; wait for application session count to reach zero |
| Deadline | On drain timeout, SIGTERM followed by Docker's bounded SIGKILL escalation |
| Failure | Roll back before old-slot drain; retain journal on uncertain outcomes |
| Safety | Dry-run default, exclusive lock, explicit ownership labels, no automatic retry after failure |

## Know the boundaries

- **Requires application cooperation.** Docker Engine plus the documented HTTP admission protocol is supported. This is not a drop-in adapter for Nginx, arbitrary Compose stacks, Kubernetes, or the reference application's current endpoints.
- Existing WebSocket/game connections remain on the old slot. They can disconnect when the drain deadline expires. Clients need reconnect/resume behavior; this is not a zero-downtime guarantee.
- Database migrations, shared volumes, background jobs, and message consumers need their own compatibility and ownership strategy.
- One writer per service and Docker daemon, one shared local state directory, enough capacity for both slots. No distributed lock or automatic crash recovery.
- Docker access grants powerful host control. Keep management endpoints private, use TLS outside a trusted local network, and read [security guidance](SECURITY.md).

[Configuration and API](docs/integration.md) · [Lifecycle and recovery](docs/operations.md) · [Disposable Docker lab](examples/lab/README.md) · [Provenance](docs/provenance.md)

MIT licensed original implementation. The separately owned reference infrastructure is not included or relicensed.
