#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Docker } from './docker.js';
import { Admission } from './http.js';
import { Store } from './store.js';
import { Deployer } from './deploy.js';
import { watch } from './watch.js';

const [command, file, ...flags] = process.argv.slice(2);
if (!['plan', 'once', 'watch'].includes(command) || !file || flags.some(f => f !== '--apply') || (command === 'plan' && flags.length)) {
  console.error('Usage: node src/cli.js <plan|once|watch> config.json [--apply]'); process.exitCode = 2;
} else {
  try {
    const c = await loadConfig(file), apply = flags.includes('--apply');
    if (command === 'watch' && !apply) throw Error('watch requires --apply; use plan for a dry run');
    const token = process.env[c.tokenEnv];
    if (apply && !token) throw Error('Configured token environment variable is missing');
    const d = new Deployer(c, new Docker(c), new Admission(c, token), new Store(c.stateDir), { log: message => console.log(JSON.stringify({ event: message })) });
    const cancel = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => cancel.abort());
    const run = async () => console.log(JSON.stringify(await d.run({ dryRun: !apply })));
    if (command === 'watch') await watch(run, c.timing.watchMs, cancel.signal);
    else await run();
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
