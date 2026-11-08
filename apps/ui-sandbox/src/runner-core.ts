import {
  CEILING_CONNECT_DOMAINS,
  comparePolicies,
  innerCsp,
  innerPolicy,
  type InnerPolicy,
} from './csp';
import { AppHost, type AppHostPort } from './app-host';
import {
  parseSandboxEvent,
  SandboxError,
  TIMEOUTS,
  type AppRequest,
  type AppStarted,
  type DisplayMode,
  type RunRequest,
  type RunResult,
  type SandboxEvent,
} from './protocol';
import { buildAppSrcdoc, buildSrcdoc } from './srcdoc';
import { VENDOR_PATHS } from './vendor';

/**
 * The runner of the second origin (D123 (4)): one inner frame at a time, of an opaque origin
 * (`allow-scripts` without `allow-same-origin`, TM-UI5), created with `srcdoc` for each run and
 * destroyed when it ends, times out, is cancelled or is replaced. Whatever the inner frame says
 * is as untrusted as the code it runs: the runner keeps only well-formed, bounded events, and at
 * most {@link MAX_EVENTS} of them per run.
 */

/** Events of one run the runner passes on; the rest are dropped. */
export const MAX_EVENTS = 200;

/** The inner frame's sandbox: scripts only. No forms, popups, modals nor navigation (TM-UI4). */
export const INNER_SANDBOX = 'allow-scripts';

/** The message that hands the inner frame its port, the only one the runner posts to it. */
export const INNER_INIT = 'mango-inner-init';

export interface RunnerAssets {
  /** Text of the inner frame's bootstrap script. */
  readonly bootstrap: string;
  /** Text of the Python worker, which the inner frame starts from a `blob:` URL. */
  readonly pythonWorker: string;
  /** Text of the bridge of an MCP App's inner frame (D125 (3)). */
  readonly appBridge: string;
}

/** What the inner frame starts with, on its port. */
export interface InnerJob {
  readonly kind: RunRequest['kind'];
  readonly source: string;
  readonly pythonWorker?: string;
  readonly pyodideUrl?: string;
}

/** An event of the inner frame as the host may see it, or `null`. Errors are cut, not dropped. */
export function fromInner(data: unknown): SandboxEvent | { type: 'done'; ok: boolean } | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.type === 'done') {
    return typeof record.ok === 'boolean' && Object.keys(record).length === 2
      ? { type: 'done', ok: record.ok }
      : null;
  }
  if (record.type === 'error' && typeof record.message === 'string') {
    const message = record.message.slice(0, 1000);
    const line = record.line;
    return parseSandboxEvent(
      typeof line === 'number' && Number.isInteger(line) && line >= 0
        ? { type: 'error', message, line }
        : { type: 'error', message },
    );
  }
  if (record.type === 'height' && typeof record.px === 'number') {
    return parseSandboxEvent({
      type: 'height',
      px: Math.min(100_000, Math.max(0, Math.ceil(record.px))),
    });
  }
  if (record.type === 'complete') return null; // the runner says when a run is complete
  return parseSandboxEvent(data);
}

export class Runner {
  private frame: HTMLIFrameElement | null = null;
  private policy: InnerPolicy | null = null;
  private current: (() => void) | null = null;
  private app: AppHost | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly origin: string,
    private readonly assets: RunnerAssets,
    private readonly notify: (event: SandboxEvent) => void,
    private readonly ceiling: readonly string[] = CEILING_CONNECT_DOMAINS,
  ) {}

  /**
   * Run `request` in a new inner frame. The policy of a runner only ever gets stricter: a
   * looser one is refused, and the host starts a new runner for it.
   */
  run(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
    let policy: InnerPolicy;
    try {
      policy = innerPolicy(request.connectDomains, this.ceiling);
    } catch (error) {
      return Promise.reject(new SandboxError('PolicyError', (error as Error).message));
    }
    if (this.policy && comparePolicies(this.policy, policy) === 'looser') {
      return Promise.reject(new SandboxError('PolicyError', 'CSP is being loosened'));
    }
    this.policy = policy;
    this.stop();
    const started = Date.now();
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', INNER_SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'Vista previa');
    frame.srcdoc = buildSrcdoc({
      kind: request.kind,
      source: request.source,
      csp: innerCsp(this.origin, policy),
      bootstrap: this.assets.bootstrap,
      origin: this.origin,
    });
    this.frame = frame;

    return new Promise<RunResult>((resolve, reject) => {
      const channel = new MessageChannel();
      let events = 0;
      let settled = false;
      const end = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        channel.port1.onmessage = null;
        channel.port1.close();
        if (this.current === cancel) this.current = null;
        settle();
      };
      const cancel = () => {
        end(() => {
          reject(new SandboxError('AbortError', 'The run was replaced or stopped.'));
        });
      };
      const onAbort = () => {
        end(() => {
          reject(new SandboxError('AbortError', 'The run was cancelled.'));
        });
        this.stop();
      };
      const timer = setTimeout(() => {
        end(() => {
          reject(new SandboxError('TimeoutError', 'The run took too long.'));
        });
        this.stop();
      }, TIMEOUTS.runMs);
      this.current = cancel;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      channel.port1.onmessage = (message: MessageEvent<unknown>) => {
        const event = fromInner(message.data);
        if (event === null) return;
        if (event.type === 'done') {
          const durationMs = Date.now() - started;
          this.notify({ type: 'complete', durationMs });
          end(() => {
            resolve({ ok: event.ok, durationMs });
          });
          return;
        }
        events += 1;
        if (events <= MAX_EVENTS) this.notify(event);
      };
      frame.addEventListener(
        'load',
        () => {
          const target = frame.contentWindow;
          if (target === null || settled) return;
          // An opaque origin has no name to target: the frame is ours and gets only its port
          // (AGENTS.md: agreed exception to JS-MSG-001).
          target.postMessage({ type: INNER_INIT }, '*', [channel.port2]);
          const job: InnerJob =
            request.kind === 'python'
              ? {
                  kind: 'python',
                  source: request.source,
                  pythonWorker: this.assets.pythonWorker,
                  pyodideUrl: this.origin + VENDOR_PATHS.pyodide,
                }
              : { kind: request.kind, source: request.kind === 'html' ? '' : request.source };
          channel.port1.postMessage(job);
        },
        { once: true },
      );
      this.container.replaceChildren(frame);
    });
  }

  /**
   * Start the MCP App of `request` in a new inner frame (D125 (3)). Resolves once the app
   * finished `ui/initialize` and got its input and result, within the handshake time; the app
   * then lives until it is stopped or replaced. Its requests go to `host`.
   */
  startApp(request: AppRequest, host: AppHostPort, signal: AbortSignal): Promise<AppStarted> {
    let policy: InnerPolicy;
    try {
      // The CSP an app declares has no domain in v1 (D125 (7)): the mirror and nothing else.
      policy = innerPolicy([], this.ceiling);
    } catch (error) {
      return Promise.reject(new SandboxError('PolicyError', (error as Error).message));
    }
    if (this.policy && comparePolicies(this.policy, policy) === 'looser') {
      return Promise.reject(new SandboxError('PolicyError', 'CSP is being loosened'));
    }
    this.policy = policy;
    this.stop();
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', INNER_SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'App');
    frame.srcdoc = buildAppSrcdoc({
      html: request.html,
      csp: innerCsp(this.origin, policy),
      bridge: this.assets.appBridge,
    });
    this.frame = frame;

    return new Promise<AppStarted>((resolve, reject) => {
      const channel = new MessageChannel();
      let settled = false;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        done();
      };
      const app = new AppHost(
        request,
        host,
        (message) => {
          if (this.frame === frame) channel.port1.postMessage(message);
        },
        () => {
          settle(() => {
            resolve({ ok: true });
          });
        },
      );
      // What the app posts to `window.parent`: only from this frame, while it is the current one.
      const onMessage = (event: MessageEvent<unknown>) => {
        if (this.frame !== frame || event.source !== frame.contentWindow) return;
        app.receive(event.data);
      };
      const end = () => {
        window.removeEventListener('message', onMessage);
        channel.port1.close();
        if (this.app === app) this.app = null;
        settle(() => {
          reject(new SandboxError('AbortError', 'The app was closed.'));
        });
      };
      const onAbort = () => {
        this.stop();
      };
      const timer = setTimeout(() => {
        settle(() => {
          reject(new SandboxError('TimeoutError', 'The app took too long to initialize.'));
        });
        this.stop();
      }, TIMEOUTS.handshakeMs);
      this.current = end;
      this.app = app;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      window.addEventListener('message', onMessage);
      frame.addEventListener(
        'load',
        () => {
          const target = frame.contentWindow;
          if (target === null || this.frame !== frame) return;
          // An opaque origin has no name to target: the frame is ours and gets only its port
          // (AGENTS.md: agreed exception to JS-MSG-001). Everything else goes by that port.
          target.postMessage({ type: INNER_INIT }, '*', [channel.port2]);
        },
        { once: true },
      );
      this.container.replaceChildren(frame);
    });
  }

  /** The display mode the host gave the current app (its own buttons). */
  setAppDisplayMode(mode: DisplayMode): void {
    this.app?.setDisplayMode(mode);
  }

  /** Destroy the inner frame, and with it whatever it runs (its Worker too, TM-UI9). */
  stop(): void {
    const cancel = this.current;
    this.current = null;
    if (this.frame) {
      this.frame.remove();
      this.frame = null;
    }
    cancel?.();
  }
}
