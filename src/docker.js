import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { attachStdin } from './shutdown.js';
const exec = promisify(execFile);
export class Docker {
  constructor(config, runner = exec) { this.c = config; this.runner = runner; }
  async run(args, timeout = this.c.timing.commandMs) {
    try { return (await this.runner('docker', ['--context', this.c.dockerContext, ...args], {
      shell: false, timeout, maxBuffer: 1024 * 1024, windowsHide: true
    })).stdout.trim(); } catch { throw Error(`Docker ${args[0]} failed; outcome may be uncertain (output redacted)`); }
  }
  async inspect(slot) {
    const name = this.c.slots[slot].name;
    const names = (await this.run(['container', 'ls', '-a', '--format', '{{.Names}}'])).split(/\r?\n/);
    if (!names.includes(name)) return null;
    const [x] = JSON.parse(await this.run(['container', 'inspect', name]));
    if (x.Config.Labels?.['harbor-shift.group'] !== this.c.group || x.Config.Labels?.['harbor-shift.slot'] !== slot) throw Error('Container ownership mismatch');
    if (x.HostConfig.RestartPolicy.Name !== 'no') throw Error('Managed slots require restart=no');
    return { running: x.State.Running, image: x.Image };
  }
  async pull() {
    if (this.c.pullPolicy !== 'never') await this.run(['image', 'pull', this.c.image]);
    const image = await this.run(['image', 'inspect', '--format', '{{.Id}}', this.c.image]);
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw Error('Invalid image ID');
    return image;
  }
  async prepare(slot, image) {
    const old = await this.inspect(slot), s = this.c.slots[slot];
    if (old?.running) throw Error('Candidate is already running');
    const [definition] = JSON.parse(await this.run(['image', 'inspect', image]));
    if (Object.keys(definition.Config.Volumes || {}).length) throw Error('Image-declared volumes are unsupported; require a stateless image');
    if (old) await this.run(['container', 'rm', s.name]);
    // `create -i` sets StdinOnce=true in Docker CLI. Detached run explicitly
    // clears it, keeping original-process stdin reusable after attach disconnect.
    const args = ['container', ...(s.openStdin ? ['run', '--detach', '--pull', 'never'] : ['create']), '--name', s.name, '--network', this.c.network,
      '--restart', 'no', '--stop-signal', 'SIGTERM', '--label', `harbor-shift.group=${this.c.group}`,
      '--label', `harbor-shift.slot=${slot}`, '--memory', s.memory, '--cpus', String(s.cpus),
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL'];
    if (s.envFile) args.push('--env-file', s.envFile);
    if (s.openStdin) args.push('--interactive');
    for (const p of s.publish) args.push('--publish', p);
    const container = s.container || {};
    for (const file of container.envFiles || []) args.push('--env-file', file);
    for (const value of container.env || []) args.push('--env', value);
    for (const [key, value] of Object.entries(container.labels || {})) args.push('--label', `${key}=${value}`);
    for (const mount of container.mounts || []) args.push('--mount', `type=bind,src=${mount.source},dst=${mount.target},readonly`);
    if (container.user !== undefined) args.push('--user', container.user);
    if (container.workdir !== undefined) args.push('--workdir', container.workdir);
    if (container.readOnly) args.push('--read-only');
    if (container.init) args.push('--init');
    const entrypoint = container.entrypoint ?? (container.command?.length === 0 ? (definition.Config.Entrypoint || []) : undefined);
    if (entrypoint !== undefined) args.push('--entrypoint', entrypoint[0] ?? '');
    args.push(image);
    if (entrypoint !== undefined) args.push(...entrypoint.slice(1));
    if (container.command !== undefined) args.push(...container.command);
    await this.run(args);
    if (!s.openStdin) await this.run(['container', 'start', s.name]);
  }
  async stop(slot) {
    if (!(await this.inspect(slot))) return;
    await this.run(['container', 'stop', '--signal', 'SIGTERM', '--timeout', String(this.c.timing.stopSeconds), this.c.slots[slot].name]);
    if ((await this.inspect(slot))?.running) throw Error('Container did not stop');
  }
  async execHook(slot, argv, timeoutMs) {
    if (!(await this.inspect(slot))?.running) throw Error('exec hook target unavailable');
    await this.run(['container', 'exec', this.c.slots[slot].name, ...argv], timeoutMs);
  }
  async stdinHook(slot, data, timeoutMs) {
    if (!(await this.inspect(slot))?.running) throw Error('stdin hook target unavailable');
    const [x] = JSON.parse(await this.run(['container', 'inspect', this.c.slots[slot].name]));
    if (!x.Config.OpenStdin || x.Config.Tty || x.Config.StdinOnce) throw Error('stdin requires OpenStdin=true, Tty=false, StdinOnce=false on original process');
    const host = await this.run(['context', 'inspect', this.c.dockerContext, '--format', '{{.Endpoints.docker.Host}}']);
    if (!host.startsWith('unix:///')) throw Error('stdin hooks support local Unix-socket Docker contexts only');
    await attachStdin(host.slice('unix://'.length), this.c.slots[slot].name, data, timeoutMs);
  }
}
