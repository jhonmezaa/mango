import {
  call,
  INIT_TYPE,
  isSandboxOrigin,
  parseSandboxEvent,
  PROTOCOL_VERSION,
  RUNNER_METHODS,
  SandboxError,
  serve,
  TIMEOUTS,
  type RunRequest,
  type RunResult,
  type SandboxEvent,
} from '@mango/ui-sandbox/protocol';

/**
 * The SPA's side of the runner of the second origin (D123 (4), TM-UI3). It creates the runner's
 * iframe and accepts one `init` message only from that iframe's window, at the sandbox's origin,
 * with the `initId` it put in the URL and exactly the expected ports; after that it listens only
 * to those ports. It sends the runner only what there is to run: never tokens, signed URLs nor
 * internal ids (TM-UI4). No UI of its own: Canvas (K1) and MCP Apps (A2) frame it.
 */

export interface SandboxSession {
  /** Run code or HTML in a new inner frame of the runner; ends with the run. */
  run(request: RunRequest, options?: { signal?: AbortSignal }): Promise<RunResult>;
  /** Stop what runs, destroying its inner frame. */
  stop(): Promise<void>;
  /** Events of the runner (status, errors, height); returns the unsubscribe. */
  onEvent(listener: (event: SandboxEvent) => void): () => void;
  /** Remove the iframe and close the ports. */
  destroy(): void;
  readonly iframe: HTMLIFrameElement;
}

export interface OpenSandboxOptions {
  /** The sandbox origin, `https://<distribution>` (exact, D123 (1)). */
  readonly origin: string;
  /** Where the iframe goes. */
  readonly container: HTMLElement;
  /** Accessible title of the iframe. */
  readonly title: string;
  readonly signal?: AbortSignal;
  /** Only for tests: a shorter handshake. */
  readonly handshakeMs?: number;
}

/** The runner's sandbox: its own origin, scripts; it gets nothing else from the SPA. */
export const RUNNER_SANDBOX = 'allow-scripts allow-same-origin';

interface InitPorts {
  readonly ports: Record<(typeof RUNNER_METHODS)[number], MessagePort>;
  readonly replyPort: MessagePort;
}

function isPort(value: unknown): value is MessagePort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MessagePort).postMessage === 'function' &&
    typeof (value as MessagePort).start === 'function'
  );
}

/**
 * The ports of `event` if it is the runner's `init`, or `null`. Every condition must hold: the
 * window, the origin, the `initId`, the version and exactly the expected set of ports.
 */
export function acceptInit(
  event: MessageEvent<unknown>,
  expected: { source: Window | null; origin: string; initId: string },
): InitPorts | null {
  if (expected.source === null || event.source !== expected.source) return null;
  if (event.origin !== expected.origin) return null;
  const data = event.data;
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (Object.keys(message).sort().join(',') !== 'initId,ports,replyPort,type,version') return null;
  if (message.type !== INIT_TYPE || message.version !== PROTOCOL_VERSION) return null;
  if (message.initId !== expected.initId) return null;
  const ports = message.ports;
  if (typeof ports !== 'object' || ports === null) return null;
  const names = Object.keys(ports).sort();
  if (names.join(',') !== [...RUNNER_METHODS].sort().join(',')) return null;
  const record = ports as Record<string, unknown>;
  if (!RUNNER_METHODS.every((name) => isPort(record[name])) || !isPort(message.replyPort)) {
    return null;
  }
  // The ports were transferred with the message, and only those.
  const transferred = new Set<unknown>(event.ports);
  const all = [...RUNNER_METHODS.map((name) => record[name]), message.replyPort];
  if (transferred.size !== all.length || !all.every((port) => transferred.has(port))) return null;
  return { ports: record as InitPorts['ports'], replyPort: message.replyPort };
}

/** Open the runner and wait for its `init` (at most {@link TIMEOUTS.handshakeMs}). */
export function openSandbox(options: OpenSandboxOptions): Promise<SandboxSession> {
  if (!isSandboxOrigin(options.origin, import.meta.env.DEV)) {
    return Promise.reject(new SandboxError('ConfigError', 'The sandbox origin is not valid.'));
  }
  if (options.origin === window.location.origin) {
    return Promise.reject(new SandboxError('ConfigError', 'The sandbox must be another origin.'));
  }
  const initId = crypto.randomUUID();
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', RUNNER_SANDBOX);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('allow', '');
  iframe.title = options.title;
  iframe.src = `${options.origin}/sandbox.html#initId=${initId}`;

  return new Promise<SandboxSession>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: SandboxError) => {
      cleanup();
      iframe.remove();
      reject(error);
    };
    const onAbort = () => {
      fail(new SandboxError('AbortError', 'Opening the sandbox was cancelled.'));
    };
    const timer = setTimeout(() => {
      fail(new SandboxError('TimeoutError', 'The sandbox did not start in time.'));
    }, options.handshakeMs ?? TIMEOUTS.handshakeMs);
    const onMessage = (event: MessageEvent<unknown>) => {
      const accepted = acceptInit(event, {
        source: iframe.contentWindow,
        origin: options.origin,
        initId,
      });
      if (accepted === null) return;
      cleanup();
      resolve(session(iframe, accepted));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    window.addEventListener('message', onMessage);
    iframe.addEventListener('error', () => {
      fail(new SandboxError('LoadError', 'Unable to load the sandbox.'));
    });
    options.container.append(iframe);
  });
}

function session(iframe: HTMLIFrameElement, init: InitPorts): SandboxSession {
  const listeners = new Set<(event: SandboxEvent) => void>();
  // The runner's one method on this side: its events, checked and bounded (TM-UI3).
  serve(init.replyPort, {
    parse: (arg) => {
      const event = parseSandboxEvent(arg);
      if (event === null) throw new SandboxError('BadRequest', 'Not an event of the sandbox.');
      return event;
    },
    handle: (event) => {
      for (const listener of listeners) listener(event);
      return Promise.resolve(null);
    },
  });
  let destroyed = false;
  return {
    iframe,
    async run(request, runOptions = {}) {
      if (destroyed) throw new SandboxError('Closed', 'The sandbox was closed.');
      const result = await call(init.ports.run, request, {
        // The runner gives up first and destroys its inner frame.
        timeoutMs: TIMEOUTS.runMs + 5_000,
        largeStrings: ['source'],
        ...(runOptions.signal ? { signal: runOptions.signal } : {}),
      });
      if (
        typeof result !== 'object' ||
        result === null ||
        typeof (result as RunResult).ok !== 'boolean' ||
        typeof (result as RunResult).durationMs !== 'number'
      ) {
        throw new SandboxError('BadResponse', 'Not a result of the sandbox.');
      }
      return { ok: (result as RunResult).ok, durationMs: (result as RunResult).durationMs };
    },
    async stop() {
      if (destroyed) return;
      await call(init.ports.stop, null);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      for (const port of [...Object.values(init.ports), init.replyPort]) port.close();
      iframe.remove();
    },
  };
}
