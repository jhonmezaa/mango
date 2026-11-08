import {
  APP_METHOD,
  APP_TOOL,
  DISPLAY_MODES,
  isDisplayMode,
  shapeError,
  type AppRequest,
  type AppToolResult,
  type DisplayMode,
} from './protocol';

/**
 * The host side of the MCP Apps bridge (D125 (3); spec 2026-01-26), in the runner. The app is
 * HTML in an inner frame of an opaque origin: it speaks JSON-RPC with `window.parent` (this
 * runner), and this class answers it. In v1 only `ui/initialize` and its `initialized`
 * notification, `ui/request-display-mode` and `tools/call` are attended; the host sends
 * `tool-input`, `tool-result` and `host-context-changed`. Any other request (`ui/message`,
 * `ui/update-model-context`, `ui/open-link`, downloads, `resources/read`…) is answered
 * «no admitido» and counted (TM-UI7). What the app says is untrusted: every message is checked
 * against the limits of the RPC before anything is done with it.
 */

/** The version of the MCP Apps spec this host speaks. */
export const APP_PROTOCOL_VERSION = '2026-01-26';

/** JSON-RPC code of a method this host does not attend. */
export const NOT_SUPPORTED_CODE = -32601;
/** What a refused request answers (TM-UI7). */
export const NOT_SUPPORTED = 'no admitido';
/** JSON-RPC code of a request that is not valid, or of a call Mango did not make. */
export const INVALID_CODE = -32602;
export const CALL_FAILED_CODE = -32000;

/** Messages of one app the runner looks at; the rest are dropped (a flood is not served). */
export const MAX_APP_MESSAGES = 500;

/** What the host (the SPA, through the runner's RPC) does for an app. */
export interface AppHostPort {
  /** Run `tools/call` through Mango; rejects with the message to give the app. */
  callTool(name: string, args: Record<string, unknown>): Promise<AppToolResult>;
  /** Ask for a display mode; resolves with the one granted. */
  requestDisplayMode(mode: DisplayMode): Promise<DisplayMode>;
  /** A request that was refused, by its method (counted, TM-UI7). */
  refused(method: string): void;
}

type JsonRpcId = string | number;

interface JsonRpcMessage {
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `data` as a JSON-RPC request or notification of the app, or `null` (dropped). */
export function parseAppMessage(data: unknown): JsonRpcMessage | null {
  if (!isRecord(data) || data.jsonrpc !== '2.0' || shapeError(data) !== null) return null;
  const { id, method, params } = data;
  if (typeof method !== 'string') return null; // answers to the host: it asks the app nothing
  if (id !== undefined && !(typeof id === 'string' && id.length <= 64) && !Number.isInteger(id)) {
    return null;
  }
  if (params !== undefined && !isRecord(params)) return null;
  return {
    method,
    ...(id === undefined ? {} : { id: id as JsonRpcId }),
    ...(params === undefined ? {} : { params }),
  };
}

export class AppHost {
  private initialized = false;
  private messages = 0;
  private mode: DisplayMode;

  /**
   * @param send posts one JSON-RPC message to the app.
   * @param onReady is told once, when the app finished `ui/initialize` and got its data.
   */
  constructor(
    private readonly request: AppRequest,
    private readonly host: AppHostPort,
    private readonly send: (message: Record<string, unknown>) => void,
    private readonly onReady: () => void,
  ) {
    this.mode = request.displayMode;
  }

  /** The host changed the display mode (Mango's own buttons): the app is told. */
  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.initialized) {
      this.notify('ui/notifications/host-context-changed', { displayMode: mode });
    }
  }

  /** One message the app posted to `window.parent`. */
  receive(data: unknown): void {
    this.messages += 1;
    if (this.messages > MAX_APP_MESSAGES) return;
    const message = parseAppMessage(data);
    if (message === null) return;
    const { id, method } = message;
    const params = message.params ?? {};
    if (id === undefined) {
      if (method === 'ui/notifications/initialized') this.start();
      return; // any other notification changes nothing here
    }
    switch (method) {
      case 'ui/initialize':
        this.answer(id, {
          protocolVersion: APP_PROTOCOL_VERSION,
          hostInfo: { name: 'Mango', version: '1' },
          hostCapabilities: { serverTools: {} },
          hostContext: {
            displayMode: this.mode,
            availableDisplayModes: [...DISPLAY_MODES],
            theme: 'light',
            locale: 'es',
          },
        });
        return;
      case 'tools/call':
        this.callTool(id, params);
        return;
      case 'ui/request-display-mode':
        this.displayMode(id, params);
        return;
      default:
        this.host.refused(APP_METHOD.test(method) ? method : 'unknown');
        this.fail(id, NOT_SUPPORTED_CODE, NOT_SUPPORTED);
    }
  }

  private start(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.notify('ui/notifications/tool-input', { arguments: this.request.toolInput });
    this.notify('ui/notifications/tool-result', {
      content: this.request.toolResult.content.map((block) => ({ ...block })),
      isError: this.request.toolResult.isError,
    });
    this.onReady();
  }

  private callTool(id: JsonRpcId, params: Record<string, unknown>): void {
    const { name } = params;
    const args = params.arguments ?? {};
    if (!this.initialized) {
      this.fail(id, INVALID_CODE, 'the app is not initialized');
      return;
    }
    if (typeof name !== 'string' || !APP_TOOL.test(name) || !isRecord(args)) {
      this.fail(id, INVALID_CODE, 'tools/call needs a tool name and its arguments');
      return;
    }
    this.host.callTool(name, args).then(
      (result) => {
        this.answer(id, {
          content: result.content.map((block) => ({ ...block })),
          isError: result.isError,
        });
      },
      (error: unknown) => {
        const text = error instanceof Error ? error.message : 'Mango did not make the call.';
        this.fail(id, CALL_FAILED_CODE, text.slice(0, 300));
      },
    );
  }

  private displayMode(id: JsonRpcId, params: Record<string, unknown>): void {
    if (!isDisplayMode(params.mode)) {
      this.fail(id, INVALID_CODE, 'unknown display mode');
      return;
    }
    this.host.requestDisplayMode(params.mode).then(
      (granted) => {
        this.mode = granted;
        this.answer(id, { mode: granted });
      },
      () => {
        this.answer(id, { mode: this.mode });
      },
    );
  }

  private answer(id: JsonRpcId, result: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private fail(id: JsonRpcId, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params });
  }
}
