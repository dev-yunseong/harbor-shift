<div align="center">

# Harbor Shift
**New containers take new work. Old containers finish what they started.**

Automatic blue-green Docker updates with a bundled HTTP/WebSocket proxy and configurable graceful shutdown.

[Quickstart](#quickstart) · [Configuration](docs/proxy.md) · [Shutdown hooks](docs/shutdown.md) · [Advanced mode](docs/integration.md)

</div>

Run one updater container, opt in one service through configuration, and send traffic through its proxy. Harbor Shift watches the image, starts a ready replacement, switches new requests, and lets old requests and WebSockets finish. **No custom controller required.**

## Quickstart

Requires Linux Docker Engine and Compose. This starts an example web service on localhost; it publishes no images or packages.

```sh
git clone https://github.com/dev-yunseong/harbor-shift.git
cd harbor-shift
docker compose up --build -d
curl http://localhost:8080
```

Before first start, edit [`examples/proxy/service.json`](examples/proxy/service.json) for your image, internal port and readiness path. The updater manages both app slots itself and checks the configured image tag every minute. [Configuration and recovery →](docs/proxy.md)

Optional graceful shutdown hook:

```json
"shutdown": {
  "initiate": { "type": "exec", "argv": ["/app/drain"], "timeoutMs": 5000 },
  "completion": { "type": "proxy" },
  "onFailure": "keep-old"
}
```

Choose **container exec, HTTP, or original-process stdin**. Without a hook, the proxy waits for old requests/tunnels, then sends SIGTERM. Drain deadlines lead to bounded SIGKILL escalation. [Hook examples →](docs/shutdown.md)

## Know the boundaries

- Readiness gates, early rollback, exclusive locking, and an uncertainty journal. Failed updates pause polling while the proxy keeps serving its current route.
- Existing WebSockets stay on their original container. Deadlines, app failures, or restarting the proxy can still disconnect them; this is not a zero-downtime guarantee.
- One explicitly configured **stateless HTTP/1.1 or WebSocket service** per updater. No direct app host ports, shared writable volumes, arbitrary protocols, or automatic Compose-container adoption. Terminate TLS in front.
- Background work and database migrations need application coordination. Use application completion hooks when proxy counts are insufficient.
- **Docker socket access is host-root-equivalent.** Keep it private and run trusted images. [Security →](SECURITY.md)

Game lobbies can use the optional [custom admission adapter](docs/integration.md).

Verified with Linux/Windows tests and isolated real-Docker HTTP/WebSocket deployments. [Validation details →](docs/operations.md#validation-status)

[Tests & contributing](CONTRIBUTING.md) · [Recovery](docs/operations.md) · [Provenance](docs/provenance.md) · [MIT license](LICENSE)
