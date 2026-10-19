import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export class Docker {
  constructor(config, runner = exec) { this.c = config; this.runner = runner; }
  async run(args) {
    try { return (await this.runner('docker', ['--context', this.c.dockerContext, ...args], {
      shell: false, timeout: this.c.timing.commandMs, maxBuffer: 1024 * 1024, windowsHide: true
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
    await this.run(['image', 'pull', this.c.image]);
    const image = await this.run(['image', 'inspect', '--format', '{{.Id}}', this.c.image]);
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw Error('Invalid image ID');
    return image;
  }
  async prepare(slot, image) {
    const old = await this.inspect(slot), s = this.c.slots[slot];
    if (old?.running) throw Error('Candidate is already running');
    if (old) await this.run(['container', 'rm', s.name]);
    const args = ['container', 'create', '--name', s.name, '--network', this.c.network,
      '--restart', 'no', '--stop-signal', 'SIGTERM', '--label', `harbor-shift.group=${this.c.group}`,
      '--label', `harbor-shift.slot=${slot}`, '--memory', s.memory, '--cpus', String(s.cpus),
      '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL'];
    if (s.envFile) args.push('--env-file', s.envFile);
    for (const p of s.publish) args.push('--publish', p);
    args.push(image);
    await this.run(args);
    await this.run(['container', 'start', s.name]);
  }
  async stop(slot) {
    if (!(await this.inspect(slot))) return;
    await this.run(['container', 'stop', '--signal', 'SIGTERM', '--timeout', String(this.c.timing.stopSeconds), this.c.slots[slot].name]);
    if ((await this.inspect(slot))?.running) throw Error('Container did not stop');
  }
}
