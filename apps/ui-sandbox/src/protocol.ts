/**
 * The protocol between the SPA (host) and the runner of the second origin (D123 (4)), shared by
 * both sides. The runner announces itself with one `init` message to the window that framed it,
 * carrying one `MessagePort` per method the host may call plus a reply port for the few things
 * the runner tells the host. After that nothing travels through `window.postMessage`: each call
 * is `["CALL", arg]` on a method port with a fresh reply port, answered `["RESOLVE", value]` or
 * `["REJECT", error]`, and cancelled with `["ABORT"]` (TM-UI3).
 *
 * Every value that crosses is JSON-pure and bounded (entries, depth, nodes, string length, size):
 * the limits of the observed `app-block-messenger` protocol, here applied to the whole RPC. The
 * only larger field is the source code of a run, which has its own bound.
 */

export const PROTOCOL_VERSION = 1;

/** The `type` of the one message the runner sends through `window.postMessage`. */
export const INIT_TYPE = 'mango-sandbox-init';

/**
 * Methods of the runner the host calls, one port each: exactly this set (TM-UI3). `app` starts an
 * MCP App (D125 (3)) and `appContext` tells it the display mode the host gave it.
 */
export const RUNNER_METHODS = ['run', 'stop', 'app', 'appContext'] as const;
export type RunnerMethod = (typeof RUNNER_METHODS)[number];

/** Bounds of every value that crosses, in either direction. */
export const LIMITS = {
  /** Entries of one object or array. */
  entries: 32,
  /** Nesting: a value nested deeper than this is refused. */
  depth: 8,
  /** Values in the whole message, containers included. */
  nodes: 256,
  /** Characters of one string or key. */
  stringLength: 4096,
  /** Characters of the whole message as JSON (16 KiB). */
  jsonLength: 16 * 1024,
  /** Characters of the source code of one run (1 MiB): the one field above `stringLength`. */
  sourceLength: 1024 * 1024,
} as const;

/** Timeouts (TM-UI3, TM-UI9). */
export const TIMEOUTS = {
  /** From creating the iframe to an accepted `init`. */
  handshakeMs: 20_000,
  /** One call that is not a run. */
  callMs: 30_000,
  /** One run, from the call to its end: the runner then destroys the inner frame. */
  runMs: 50_000,
} as const;

/** What the runner can run (D124 (4)): React code may import `recharts`. */
export const RUN_KINDS = ['html', 'react', 'python'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export interface RunRequest {
  readonly kind: RunKind;
  /** The code or the HTML to run; nothing else of the document travels (TM-UI4). */
  readonly source: string;
  /**
   * Origins the inner frame may connect to, besides the mirror. Only within the ceiling of the
   * runner (none until A1 brings the curated domains of MCP Apps), and only ever stricter for
   * one runner: a looser policy is refused and needs a new runner.
   */
  readonly connectDomains?: readonly string[];
}

export interface RunResult {
  readonly ok: boolean;
  readonly durationMs: number;
}

/** Display modes of an MCP App (`ui/request-display-mode`, D125 (3)). */
export const DISPLAY_MODES = ['inline', 'fullscreen', 'pip'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];

/** A block of a tool result as it reaches an app: text only (what the Gateway answered). */
export interface AppContentBlock {
  readonly type: 'text';
  readonly text: string;
}

/** `CallToolResult` of MCP, as Mango gives it to an app: text blocks and the error mark. */
export interface AppToolResult {
  readonly content: readonly AppContentBlock[];
  readonly isError: boolean;
}

/** What the host sends to start an MCP App: its HTML, already checked against its hash. */
export interface AppRequest {
  readonly html: string;
  /** The arguments the model called the tool with (`ui/notifications/tool-input`). */
  readonly toolInput: Record<string, unknown>;
  /** What the tool answered (`ui/notifications/tool-result`). */
  readonly toolResult: AppToolResult;
  readonly displayMode: DisplayMode;
}

/** The answer of `app`: the app finished `ui/initialize` and got its input and result. */
export interface AppStarted {
  readonly ok: true;
}

/** Keys whose strings may be up to `LIMITS.sourceLength` in what concerns an app. */
export const APP_LARGE_STRINGS = ['html', 'text'] as const;

/** Phases a run reports while it goes. */
export const RUN_PHASES = ['initializing', 'loading-packages', 'running'] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

/** What the runner tells the host (its one method on the host side): short, never the output. */
export type SandboxEvent =
  | { readonly type: 'status'; readonly phase: RunPhase }
  | { readonly type: 'error'; readonly message: string; readonly line?: number }
  | { readonly type: 'complete'; readonly durationMs: number }
  | { readonly type: 'height'; readonly px: number }
  | { readonly type: 'csp-violation'; readonly directive: string }
  // What an MCP App asks of the host (D125 (3), (4)): answered by the host's handler.
  | {
      readonly type: 'app-tool-call';
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly type: 'app-display-mode'; readonly mode: DisplayMode }
  // A request of the app the host does not attend (TM-UI7): counted, answered «no admitido».
  | { readonly type: 'app-refused'; readonly method: string };

export const SANDBOX_EVENT_TYPES = [
  'status',
  'error',
  'complete',
  'height',
  'csp-violation',
  'app-tool-call',
  'app-display-mode',
  'app-refused',
] as const;

/** A method name of the MCP Apps bridge as it may cross: short, plain. */
export const APP_METHOD = /^[A-Za-z][A-Za-z0-9_/-]{0,63}$/;
/** A tool name, as the profile writes it. */
export const APP_TOOL = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** An error as it crosses: a name and a message, never a stack. */
export interface WireError {
  readonly name: string;
  readonly message: string;
}

export class SandboxError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/**
 * Why `value` cannot cross, or `null` when it can: JSON-pure (null, booleans, finite numbers,
 * strings, arrays and plain objects), within {@link LIMITS}. `largeStrings` names the object
 * keys whose string may reach `LIMITS.sourceLength` (only `source` of a run); those strings are
 * left out of the JSON size.
 */
export function shapeError(value: unknown, largeStrings: readonly string[] = []): string | null {
  let nodes = 0;
  let length = 0;
  const visit = (node: unknown, depth: number, key: string | null): string | null => {
    nodes += 1;
    if (nodes > LIMITS.nodes) return 'too many values';
    if (depth > LIMITS.depth) return 'nested too deep';
    if (node === null || typeof node === 'boolean') {
      length += 5;
      return null;
    }
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) return 'a number that is not finite';
      length += String(node).length;
      return null;
    }
    if (typeof node === 'string') {
      const large = key !== null && largeStrings.includes(key);
      if (node.length > (large ? LIMITS.sourceLength : LIMITS.stringLength)) {
        return 'a string too long';
      }
      if (!large) length += node.length + 2;
      return null;
    }
    if (Array.isArray(node)) {
      if (node.length > LIMITS.entries) return 'an array too long';
      length += 2;
      for (const item of node) {
        const error = visit(item, depth + 1, null);
        if (error) return error;
      }
      return null;
    }
    if (typeof node === 'object') {
      const prototype = Object.getPrototypeOf(node) as unknown;
      if (prototype !== Object.prototype && prototype !== null) return 'not a plain object';
      const entries = Object.entries(node);
      if (entries.length > LIMITS.entries) return 'an object with too many keys';
      length += 2;
      for (const [name, item] of entries) {
        if (name.length > LIMITS.stringLength) return 'a key too long';
        length += name.length + 3;
        const error = visit(item, depth + 1, name);
        if (error) return error;
      }
      return null;
    }
    return `a value of type ${typeof node}`;
  };
  const error = visit(value, 0, null);
  if (error) return error;
  return length > LIMITS.jsonLength ? 'too large' : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` as a run request, or a {@link SandboxError} (`BadRequest`). */
export function parseRunRequest(value: unknown): RunRequest {
  const error = shapeError(value, ['source']);
  if (error) throw new SandboxError('BadRequest', `run: ${error}`);
  if (!isRecord(value)) throw new SandboxError('BadRequest', 'run: not an object');
  const { kind, source, connectDomains, ...rest } = value;
  if (Object.keys(rest).length > 0) throw new SandboxError('BadRequest', 'run: unknown fields');
  if (typeof kind !== 'string' || !(RUN_KINDS as readonly string[]).includes(kind)) {
    throw new SandboxError('BadRequest', 'run: unknown kind');
  }
  if (typeof source !== 'string') throw new SandboxError('BadRequest', 'run: no source');
  if (connectDomains !== undefined) {
    if (!Array.isArray(connectDomains) || !connectDomains.every((d) => typeof d === 'string')) {
      throw new SandboxError('BadRequest', 'run: connectDomains must be strings');
    }
    return { kind: kind as RunKind, source, connectDomains };
  }
  return { kind: kind as RunKind, source };
}

/** `value` as an event of the runner, or `null`: the host drops anything else. */
export function parseSandboxEvent(value: unknown): SandboxEvent | null {
  if (shapeError(value) !== null || !isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  switch (value.type) {
    case 'status':
      return keys === 'phase,type' &&
        typeof value.phase === 'string' &&
        (RUN_PHASES as readonly string[]).includes(value.phase)
        ? { type: 'status', phase: value.phase as RunPhase }
        : null;
    case 'error': {
      if (typeof value.message !== 'string') return null;
      if (keys === 'message,type') return { type: 'error', message: value.message };
      return keys === 'line,message,type' && isCount(value.line)
        ? { type: 'error', message: value.message, line: value.line }
        : null;
    }
    case 'complete':
      return keys === 'durationMs,type' && isCount(value.durationMs)
        ? { type: 'complete', durationMs: value.durationMs }
        : null;
    case 'height':
      return keys === 'px,type' && isCount(value.px) && value.px <= 100_000
        ? { type: 'height', px: value.px }
        : null;
    case 'csp-violation':
      return keys === 'directive,type' &&
        typeof value.directive === 'string' &&
        /^[a-z-]{1,40}$/.test(value.directive)
        ? { type: 'csp-violation', directive: value.directive }
        : null;
    case 'app-tool-call':
      return keys === 'arguments,name,type' &&
        typeof value.name === 'string' &&
        APP_TOOL.test(value.name) &&
        isRecord(value.arguments)
        ? { type: 'app-tool-call', name: value.name, arguments: value.arguments }
        : null;
    case 'app-display-mode':
      return keys === 'mode,type' && isDisplayMode(value.mode)
        ? { type: 'app-display-mode', mode: value.mode }
        : null;
    case 'app-refused':
      return keys === 'method,type' &&
        typeof value.method === 'string' &&
        APP_METHOD.test(value.method)
        ? { type: 'app-refused', method: value.method }
        : null;
    default:
      return null;
  }
}

export function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === 'string' && (DISPLAY_MODES as readonly string[]).includes(value);
}

/** `value` as a tool result an app may get, or `null`: text blocks and the error mark only. */
export function parseAppToolResult(value: unknown): AppToolResult | null {
  if (shapeError(value, APP_LARGE_STRINGS) !== null || !isRecord(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'content,isError') return null;
  const { content, isError } = value;
  if (typeof isError !== 'boolean' || !Array.isArray(content)) return null;
  const blocks: AppContentBlock[] = [];
  for (const block of content) {
    if (!isRecord(block) || Object.keys(block).sort().join(',') !== 'text,type') return null;
    if (block.type !== 'text' || typeof block.text !== 'string') return null;
    blocks.push({ type: 'text', text: block.text });
  }
  return { content: blocks, isError };
}

/** `value` as a request to start an MCP App, or a {@link SandboxError} (`BadRequest`). */
export function parseAppRequest(value: unknown): AppRequest {
  const error = shapeError(value, APP_LARGE_STRINGS);
  if (error) throw new SandboxError('BadRequest', `app: ${error}`);
  if (!isRecord(value)) throw new SandboxError('BadRequest', 'app: not an object');
  const { html, toolInput, toolResult, displayMode, ...rest } = value;
  if (Object.keys(rest).length > 0) throw new SandboxError('BadRequest', 'app: unknown fields');
  if (typeof html !== 'string' || html.length === 0) {
    throw new SandboxError('BadRequest', 'app: no html');
  }
  if (!isRecord(toolInput)) throw new SandboxError('BadRequest', 'app: toolInput');
  const result = parseAppToolResult(toolResult);
  if (result === null) throw new SandboxError('BadRequest', 'app: toolResult');
  if (!isDisplayMode(displayMode)) throw new SandboxError('BadRequest', 'app: displayMode');
  return { html, toolInput, toolResult: result, displayMode };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** An error as it crosses: name and message, cut to the limits. */
export function toWireError(error: unknown): WireError {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : 'The sandbox call failed.';
  return {
    name: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Error',
    message: message.slice(0, 1000),
  };
}

function fromWireError(value: unknown): SandboxError {
  if (isRecord(value) && typeof value.name === 'string' && typeof value.message === 'string') {
    return new SandboxError(value.name.slice(0, 64), value.message.slice(0, 1000));
  }
  return new SandboxError('Error', 'The sandbox call failed.');
}

/** A handler of one method: its argument already validated by `parse`. */
export interface Method<T> {
  readonly parse: (arg: unknown) => T;
  readonly handle: (arg: T, signal: AbortSignal) => Promise<unknown>;
  /** Keys whose strings the answer may carry up to `LIMITS.sourceLength`. */
  readonly answerLargeStrings?: readonly string[];
}

/**
 * Answer calls on `port`: `["CALL", arg]` with exactly one reply port. Anything else is dropped.
 * The answer is checked against the limits like every value that crosses.
 */
export function serve<T>(port: MessagePort, method: Method<T>): void {
  port.onmessage = (event: MessageEvent<unknown>) => {
    const reply = event.ports[0];
    if (event.ports.length !== 1 || reply === undefined) return;
    const data = event.data;
    if (!Array.isArray(data) || data.length !== 2 || data[0] !== 'CALL') {
      reply.close();
      return;
    }
    const controller = new AbortController();
    reply.onmessage = (message: MessageEvent<unknown>) => {
      if (Array.isArray(message.data) && message.data[0] === 'ABORT') controller.abort();
    };
    void (async () => {
      try {
        const value = await method.handle(method.parse(data[1]), controller.signal);
        const error = shapeError(value ?? null, method.answerLargeStrings);
        if (error) throw new SandboxError('BadResponse', `answer: ${error}`);
        reply.postMessage(['RESOLVE', value ?? null]);
      } catch (error) {
        reply.postMessage(['REJECT', toWireError(error)]);
      } finally {
        reply.close();
      }
    })();
  };
}

export interface CallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Keys whose strings may be up to `LIMITS.sourceLength` (see {@link shapeError}). */
  readonly largeStrings?: readonly string[];
  /** The same, for the answer (a tool result an app asked for). */
  readonly answerLargeStrings?: readonly string[];
}

/**
 * Call the method behind `port` with `arg`, bounded in size and in time. On timeout or abort the
 * other side gets `["ABORT"]`. The answer is checked against the limits before it is returned.
 */
export function call(port: MessagePort, arg: unknown, options: CallOptions = {}): Promise<unknown> {
  const error = shapeError(arg, options.largeStrings);
  if (error) return Promise.reject(new SandboxError('BadRequest', error));
  const channel = new MessageChannel();
  return new Promise<unknown>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      channel.port1.onmessage = null;
      channel.port1.close();
      settle();
    };
    const abort = (reason: SandboxError) => {
      channel.port1.postMessage(['ABORT']);
      finish(() => {
        reject(reason);
      });
    };
    const onAbort = () => {
      abort(new SandboxError('AbortError', 'The sandbox call was cancelled.'));
    };
    const timer = setTimeout(() => {
      abort(new SandboxError('TimeoutError', 'The sandbox call timed out.'));
    }, options.timeoutMs ?? TIMEOUTS.callMs);
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!Array.isArray(data) || data.length !== 2) return;
      if (data[0] === 'RESOLVE') {
        const problem = shapeError(data[1], options.answerLargeStrings);
        finish(() => {
          if (problem) reject(new SandboxError('BadResponse', problem));
          else resolve(data[1]);
        });
      } else if (data[0] === 'REJECT') {
        finish(() => {
          reject(fromWireError(data[1]));
        });
      }
    };
    port.postMessage(['CALL', arg], [channel.port2]);
  });
}

/** The `initId` of an iframe's URL: a random UUID per start, in the hash (TM-UI3). */
export const INIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An exact `https` origin, or `http` on the loopback for local development and tests. */
export function isSandboxOrigin(value: string, allowLoopback: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  // Host names only: no wildcard (`*.cloudfront.net` would be any distribution, TM-UI2).
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(url.hostname)) {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return (
    allowLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
  );
}
