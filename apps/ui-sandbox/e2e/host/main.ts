// The host of the end-to-end tests: the SPA's own utility (apps/web/src/sandbox), nothing else.
import type { RunRequest, SandboxEvent } from '../../src/protocol';
import { openSandbox } from '../../../web/src/sandbox/sandboxHost';

declare global {
  interface Window {
    runInSandbox: (request: RunRequest) => Promise<{ ok: boolean | null; error: string | null }>;
    /** Every event of the last session, also those that arrive after its run. */
    sandboxEvents: SandboxEvent[];
  }
}

window.runInSandbox = async (request) => {
  const slot = document.getElementById('slot');
  if (!slot) throw new Error('no slot');
  const events: SandboxEvent[] = [];
  window.sandboxEvents = events;
  const session = await openSandbox({
    origin: 'http://127.0.0.1:4601',
    container: slot,
    title: 'Vista previa',
  });
  session.onEvent((event) => events.push(event));
  try {
    const result = await session.run(request);
    return { ok: result.ok, error: null };
  } catch (error) {
    return { ok: null, error: (error as Error).message };
  }
};
