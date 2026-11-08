import bootstrapUrl from './inner/bootstrap.ts?worker&url';
import pythonWorkerUrl from './inner/python-worker.ts?worker&url';
import {
  INIT_ID,
  INIT_TYPE,
  isSandboxOrigin,
  parseRunRequest,
  PROTOCOL_VERSION,
  serve,
  call,
  type SandboxEvent,
} from './protocol';
import { Runner } from './runner-core';

/**
 * The entry point of `sandbox.html`, the runner of the second origin (D123 (4)). It answers only
 * the window that framed it, at the SPA's origin: that origin comes from `runner-config.json`,
 * written by the deployment (never from the URL), and `frame-ancestors` already keeps any other
 * site from framing it (TM-UI11). One `init` message with its ports, then nothing more through
 * the window (TM-UI3).
 */

/** The SPA's origin, from the deployment's `runner-config.json`. */
async function spaOrigin(): Promise<string | null> {
  const response = await fetch('/runner-config.json', { cache: 'no-store', credentials: 'omit' });
  if (!response.ok) return null;
  const config = (await response.json()) as { spaOrigin?: unknown };
  const origin = config.spaOrigin;
  const loopback = import.meta.env.DEV || import.meta.env.VITE_SANDBOX_LOOPBACK === 'true';
  return typeof origin === 'string' && isSandboxOrigin(origin, loopback) ? origin : null;
}

async function text(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`asset ${url}: ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  if (window.parent === window) return; // only ever inside the SPA's frame
  const initId = new URLSearchParams(location.hash.slice(1)).get('initId');
  if (initId === null || !INIT_ID.test(initId)) return;
  const [target, bootstrap, pythonWorker] = await Promise.all([
    spaOrigin(),
    text(bootstrapUrl),
    text(pythonWorkerUrl),
  ]);
  if (target === null) return;
  const root = document.getElementById('frame');
  if (!root) return;

  const run = new MessageChannel();
  const stop = new MessageChannel();
  const reply = new MessageChannel();
  const notify = (event: SandboxEvent) => {
    call(reply.port1, event).catch(() => undefined);
  };
  const runner = new Runner(root, location.origin, { bootstrap, pythonWorker }, notify);
  serve(run.port1, {
    parse: parseRunRequest,
    handle: (request, signal) => runner.run(request, signal),
  });
  serve(stop.port1, {
    parse: (arg) => arg,
    handle: () => {
      runner.stop();
      return Promise.resolve(null);
    },
  });
  window.parent.postMessage(
    {
      type: INIT_TYPE,
      version: PROTOCOL_VERSION,
      initId,
      ports: { run: run.port2, stop: stop.port2 },
      replyPort: reply.port2,
    },
    target,
    [run.port2, stop.port2, reply.port2],
  );
}

void main();
