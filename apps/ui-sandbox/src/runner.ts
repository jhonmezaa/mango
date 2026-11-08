import appBridgeUrl from './inner/app-bridge.ts?worker&url';
import bootstrapUrl from './inner/bootstrap.ts?worker&url';
import pythonWorkerUrl from './inner/python-worker.ts?worker&url';
import {
  APP_LARGE_STRINGS,
  INIT_ID,
  INIT_TYPE,
  isDisplayMode,
  isSandboxOrigin,
  parseAppRequest,
  parseAppToolResult,
  parseRunRequest,
  PROTOCOL_VERSION,
  SandboxError,
  serve,
  call,
  type DisplayMode,
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
  const [target, bootstrap, pythonWorker, appBridge] = await Promise.all([
    spaOrigin(),
    text(bootstrapUrl),
    text(pythonWorkerUrl),
    text(appBridgeUrl),
  ]);
  if (target === null) return;
  const root = document.getElementById('frame');
  if (!root) return;

  const run = new MessageChannel();
  const stop = new MessageChannel();
  const app = new MessageChannel();
  const appContext = new MessageChannel();
  const reply = new MessageChannel();
  const notify = (event: SandboxEvent) => {
    call(reply.port1, event).catch(() => undefined);
  };
  const runner = new Runner(root, location.origin, { bootstrap, pythonWorker, appBridge }, notify);
  serve(run.port1, {
    parse: parseRunRequest,
    handle: (request, signal) => runner.run(request, signal),
  });
  // What an MCP App asks of the host goes on the reply port, and its answer comes back there.
  const appHost = {
    async callTool(name: string, args: Record<string, unknown>) {
      const answer = await call(
        reply.port1,
        { type: 'app-tool-call', name, arguments: args } satisfies SandboxEvent,
        // mango-api answers within its own limit of the Gateway call (60 s).
        { timeoutMs: 70_000, answerLargeStrings: APP_LARGE_STRINGS },
      );
      const result = parseAppToolResult(answer);
      if (result === null) throw new SandboxError('BadResponse', 'Not a tool result.');
      return result;
    },
    async requestDisplayMode(mode: DisplayMode) {
      const answer = await call(reply.port1, {
        type: 'app-display-mode',
        mode,
      } satisfies SandboxEvent);
      const granted = (answer as { mode?: unknown } | null)?.mode;
      return isDisplayMode(granted) ? granted : 'inline';
    },
    refused(method: string) {
      notify({ type: 'app-refused', method });
    },
  };
  serve(app.port1, {
    parse: parseAppRequest,
    handle: (request, signal) => runner.startApp(request, appHost, signal),
  });
  serve(appContext.port1, {
    parse: (arg) => {
      const mode = (arg as { displayMode?: unknown } | null)?.displayMode;
      if (!isDisplayMode(mode)) throw new SandboxError('BadRequest', 'appContext: displayMode');
      return mode;
    },
    handle: (mode) => {
      runner.setAppDisplayMode(mode);
      return Promise.resolve(null);
    },
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
      ports: { run: run.port2, stop: stop.port2, app: app.port2, appContext: appContext.port2 },
      replyPort: reply.port2,
    },
    target,
    [run.port2, stop.port2, app.port2, appContext.port2, reply.port2],
  );
}

void main();
