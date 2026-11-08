// The host of the end-to-end tests: the SPA's own utility (apps/web/src/sandbox), nothing else.
import type {
  AppRequest,
  AppToolResult,
  DisplayMode,
  RunRequest,
  SandboxEvent,
} from '../../src/protocol';
import { openSandbox } from '../../../web/src/sandbox/sandboxHost';

declare global {
  interface Window {
    runInSandbox: (request: RunRequest) => Promise<{ ok: boolean | null; error: string | null }>;
    /** Every event of the last session, also those that arrive after its run. */
    sandboxEvents: SandboxEvent[];
    /** Start an MCP App; its tool calls answer `answers[name]` and are recorded. */
    startAppInSandbox: (
      request: AppRequest,
      answers: Record<string, AppToolResult>,
    ) => Promise<{ ok: boolean; error: string | null }>;
    appCalls: { name: string; arguments: Record<string, unknown> }[];
    appModes: DisplayMode[];
    appRefused: string[];
  }
}

window.startAppInSandbox = async (request, answers) => {
  const slot = document.getElementById('slot');
  if (!slot) throw new Error('no slot');
  window.appCalls = [];
  window.appModes = [];
  window.appRefused = [];
  const session = await openSandbox({
    origin: 'http://127.0.0.1:4601',
    container: slot,
    title: 'App',
  });
  try {
    await session.startApp(request, {
      callTool: (name, args) => {
        window.appCalls.push({ name, arguments: args });
        const answer = answers[name];
        return answer ? Promise.resolve(answer) : Promise.reject(new Error('permiso denegado'));
      },
      requestDisplayMode: (mode) => {
        window.appModes.push(mode);
        return mode === 'pip' ? 'inline' : mode;
      },
      refused: (method) => window.appRefused.push(method),
    });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
};

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
