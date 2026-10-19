// Pure in-memory lifecycle demonstration: no Docker, registry or external HTTP.
import { fixture } from '../test/helpers.js';
const demo = fixture();
console.log(await demo.deployer.run({ dryRun: false }));
console.log(demo.events.join('\n'));
