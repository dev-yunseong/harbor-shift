# Contributing

Use Node.js 24 or later. YAML parsing uses the locked yaml dependency; install scripts are not required.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
node src/cli.js plan examples/config.json
node src/proxy-cli.js examples/proxy/service.json
```

Keep README short; put operational detail in docs. Add failure-path tests for lifecycle changes, especially uncertain remote outcomes and rollback. Adapter changes need isolated contract tests and, when available, a disposable Docker run. Never point tests at real deployment contexts. Do not claim compatibility based only on mocks.

Linux CI runs `HARBOR_DOCKER_TEST=1 node --test --test-concurrency=1 integration/*.test.js` on its disposable Docker Engine. Tests use unique names, bounded commands, ownership-checked cleanup, and local builds only. Normal unit tests never touch Docker. The advanced test substitutes local image resolution for registry pulling; the bundled test uses the real runtime with explicit `pullPolicy: never`. Neither validates private-registry authentication.

Contributions must be original or licensed for redistribution under this project's MIT license. Do not copy code, identifiers or credentials from the reference infrastructure. Describe validation and remaining integration gaps in your pull request. No CLA is currently required.
