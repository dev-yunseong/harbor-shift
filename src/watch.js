import { setTimeout as sleep } from 'node:timers/promises';

// Sequential by construction; failures propagate without an automatic retry.
export async function watch(run, interval, signal, pause = sleep) {
  while (!signal.aborted) {
    await run();
    if (signal.aborted) break;
    try { await pause(interval, undefined, { signal }); }
    catch (e) { if (!signal.aborted) throw e; }
  }
}
