# Disposable Docker lab

This example includes a minimal admission controller, two slots, and an HTTP request representing in-flight work. Use a dedicated disposable Linux Docker Engine/context with no production containers. It has not been run on the development computer, where Docker was unavailable. Node.js 24 and `curl` are needed on the host. Commands below use a POSIX shell from the repository root. They intentionally create containers only when you run them.

The fixture uses a public demonstration token, loopback ports, an unauthenticated local registry, and an in-memory route. It is not production software. Controller restart loses its route/revision; never use this fixture for crash-recovery guarantees. The sample app validates new admissions against the controller, keeps accepted work alive while draining, and reports its active work count. Production allocation needs atomic admission or reservation semantics to eliminate read/assignment races.

## Start version 1

Check `docker context show` and update **all commands and config** if your disposable context is not `default`. Ensure ports 5500, 9090, 9101 and 9102 and the `hs-lab-*` names are unused. Do not change daemon network/security settings to make this example work; use an engine that already supports loopback registry access.

```sh
docker --context default network create hs-lab
docker --context default run -d --name hs-lab-registry -p 127.0.0.1:5500:5000 registry:2
docker --context default build --build-arg VERSION=v1 -t localhost:5500/hs-lab:latest examples/lab
docker --context default push localhost:5500/hs-lab:latest
docker --context default run -d --name hs-lab-controller --network hs-lab -p 127.0.0.1:9090:8080 -e MODE=controller -e HARBOR_TOKEN=local-demo-only localhost:5500/hs-lab:latest
docker --context default run -d --name hs-lab-blue --network hs-lab --restart=no --label harbor-shift.group=hs-lab --label harbor-shift.slot=blue --env-file examples/lab/blue.env.example -p 127.0.0.1:9101:8080 --memory 128m --cpus 1 --cap-drop ALL --security-opt no-new-privileges localhost:5500/hs-lab:latest
export HARBOR_TOKEN=local-demo-only
curl -fsS -H "Authorization: Bearer $HARBOR_TOKEN" http://127.0.0.1:9101/ready
node src/cli.js once examples/lab/config.json --apply
```

The first deployment should report `unchanged`. No green container exists yet.

## Update while work is running

In terminal A:

```sh
curl -fsS -H 'Authorization: Bearer local-demo-only' 'http://127.0.0.1:9101/work?ms=15000'
```

Immediately in terminal B (or build/push version 2 before starting the long request):

```sh
docker --context default build --build-arg VERSION=v2 -t localhost:5500/hs-lab:latest examples/lab
docker --context default push localhost:5500/hs-lab:latest
node src/cli.js once examples/lab/config.json --apply
curl -fsS -H 'Authorization: Bearer local-demo-only' http://127.0.0.1:9090/assign
curl -fsS -H 'Authorization: Bearer local-demo-only' http://127.0.0.1:9102/work
```

Expected: terminal A finishes on blue/v1; new work completes on green/v2; blue stops after its session count reaches zero. Run `watch ... --apply` instead of `once` to detect later tag changes. To exercise a forced deadline, use a 60000 ms work request with the default 20000 ms drain window; it can be disconnected when stop grace expires. An unhealthy image, invalid readiness URL, and controller rejection should be tested before any real deployment.

## Cleanup

Stop Harbor Shift first. These commands target only the fixture names; run them only for resources created above. Images and the local state journal are deliberately retained for inspection.

```sh
docker --context default rm -f hs-lab-blue hs-lab-green hs-lab-controller hs-lab-registry
docker --context default network rm hs-lab
```

If green was never created, its removal reports an error. Inspect any interrupted transaction before manually removing the lab state directory to start again.
