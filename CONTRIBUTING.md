# Contributing

Use Node.js 24 or later. There are no runtime dependencies or install scripts.

```sh
npm test
npm run demo
node src/cli.js plan examples/config.json
```

Keep README short; put operational detail in docs. Add failure-path tests for lifecycle changes, especially uncertain remote outcomes and rollback. Adapter changes need isolated contract tests and, when available, a disposable Docker run. Never point tests at real deployment contexts. Do not claim compatibility based only on mocks.

Contributions must be original or licensed for redistribution under this project's MIT license. Do not copy code, identifiers or credentials from the reference infrastructure. Describe validation and remaining integration gaps in your pull request. No CLA is currently required.
