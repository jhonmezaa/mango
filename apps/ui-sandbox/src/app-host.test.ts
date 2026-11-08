import { describe, expect, it, vi } from 'vitest';
import {
  APP_PROTOCOL_VERSION,
  AppHost,
  CALL_FAILED_CODE,
  MAX_APP_MESSAGES,
  NOT_SUPPORTED,
  NOT_SUPPORTED_CODE,
  parseAppMessage,
  type AppHostPort,
} from './app-host';
import type { AppRequest } from './protocol';

const REQUEST: AppRequest = {
  html: '<p>app</p>',
  toolInput: { action: 'get', id: 4821 },
  toolResult: { content: [{ type: 'text', text: '{"id":4821}' }], isError: false },
  displayMode: 'inline',
};

function setup(port: Partial<AppHostPort> = {}) {
  const sent: Record<string, unknown>[] = [];
  const ready = vi.fn();
  const callTool = vi.fn<AppHostPort['callTool']>(() =>
    Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }], isError: false }),
  );
  const refused = vi.fn<AppHostPort['refused']>();
  const host: AppHostPort = {
    callTool,
    requestDisplayMode: (mode) => Promise.resolve(mode),
    refused,
    ...port,
  };
  const app = new AppHost(REQUEST, host, (m) => sent.push(m), ready);
  return { app, host: { callTool, refused }, sent, ready };
}

const rpc = (method: string, params?: object, id?: number) => ({
  jsonrpc: '2.0',
  method,
  ...(id === undefined ? {} : { id }),
  ...(params === undefined ? {} : { params }),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the host side of MCP Apps (D125 (3))', () => {
  it('initializes, then sends the tool input and result, and says it is ready', () => {
    const { app, sent, ready } = setup();
    app.receive(rpc('ui/initialize', { protocolVersion: APP_PROTOCOL_VERSION }, 1));
    expect(sent[0]).toMatchObject({
      id: 1,
      result: {
        protocolVersion: APP_PROTOCOL_VERSION,
        hostInfo: { name: 'Mango' },
        hostContext: {
          displayMode: 'inline',
          availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        },
      },
    });
    expect(ready).not.toHaveBeenCalled();
    app.receive(rpc('ui/notifications/initialized'));
    expect(sent.slice(1)).toEqual([
      rpc('ui/notifications/tool-input', { arguments: REQUEST.toolInput }),
      rpc('ui/notifications/tool-result', REQUEST.toolResult),
    ]);
    expect(ready).toHaveBeenCalledOnce();
    app.receive(rpc('ui/notifications/initialized'));
    expect(sent).toHaveLength(3);
  });

  it('passes tools/call to Mango and answers what Mango answered', async () => {
    const { app, host, sent } = setup();
    app.receive(rpc('ui/notifications/initialized'));
    app.receive(rpc('tools/call', { name: 'wit_work_item', arguments: { id: 1 } }, 7));
    await flush();
    expect(host.callTool).toHaveBeenCalledWith('wit_work_item', { id: 1 });
    expect(sent.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'ok' }], isError: false },
    });
  });

  it('answers a call Mango did not make with its reason', async () => {
    const { app, sent } = setup({
      callTool: () => Promise.reject(new Error('sin presupuesto')),
    });
    app.receive(rpc('ui/notifications/initialized'));
    app.receive(rpc('tools/call', { name: 'wit_work_item', arguments: {} }, 8));
    await flush();
    expect(sent.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 8,
      error: { code: CALL_FAILED_CODE, message: 'sin presupuesto' },
    });
  });

  it('refuses tools/call before initialized, or without a valid name', () => {
    const { app, host, sent } = setup();
    app.receive(rpc('tools/call', { name: 'wit_work_item' }, 1));
    expect(host.callTool).not.toHaveBeenCalled();
    app.receive(rpc('ui/notifications/initialized'));
    app.receive(rpc('tools/call', { name: '../x' }, 2));
    app.receive(rpc('tools/call', { name: 'x', arguments: [1] }, 3));
    expect(host.callTool).not.toHaveBeenCalled();
    expect(sent.filter((m) => 'error' in m).map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('asks Mango for a display mode and tells the app what it got', async () => {
    const { app, host, sent } = setup({ requestDisplayMode: () => Promise.resolve('inline') });
    app.receive(rpc('ui/request-display-mode', { mode: 'fullscreen' }, 4));
    await flush();
    expect(sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 4, result: { mode: 'inline' } });
    app.receive(rpc('ui/request-display-mode', { mode: 'modal' }, 5));
    expect(sent.at(-1)).toMatchObject({ id: 5, error: {} });
    expect(host.refused).not.toHaveBeenCalled();
  });

  it('tells an initialized app when Mango changes its display mode', () => {
    const { app, sent } = setup();
    app.setDisplayMode('pip');
    expect(sent).toHaveLength(0);
    app.receive(rpc('ui/notifications/initialized'));
    app.setDisplayMode('fullscreen');
    app.setDisplayMode('fullscreen');
    expect(sent.at(-1)).toEqual(
      rpc('ui/notifications/host-context-changed', { displayMode: 'fullscreen' }),
    );
    expect(sent).toHaveLength(3);
  });

  it.each([
    'ui/message',
    'ui/update-model-context',
    'ui/open-link',
    'ui/download-file',
    'resources/read',
    'ping',
  ])('answers %s «no admitido» and counts it (TM-UI7)', (method) => {
    const { app, host, sent } = setup();
    app.receive(rpc(method, { text: 'hola' }, 9));
    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 9, error: { code: NOT_SUPPORTED_CODE, message: NOT_SUPPORTED } },
    ]);
    expect(host.refused).toHaveBeenCalledWith(method);
  });

  it('drops what is not a bounded JSON-RPC request, and a flood', () => {
    const { app, sent } = setup();
    for (const data of [
      null,
      'x',
      { jsonrpc: '1.0', method: 'ui/initialize', id: 1 },
      { jsonrpc: '2.0', id: 1 },
    ]) {
      app.receive(data);
    }
    app.receive(rpc('ui/initialize', { big: 'x'.repeat(20_000) }, 1));
    expect(sent).toHaveLength(0);
    for (let i = 0; i < MAX_APP_MESSAGES; i += 1) app.receive({ junk: i });
    app.receive(rpc('ui/initialize', {}, 2));
    expect(sent).toHaveLength(0);
  });

  it('parses only requests and notifications with plain params', () => {
    expect(parseAppMessage(rpc('tools/call', { name: 'a' }, 1))).toEqual({
      id: 1,
      method: 'tools/call',
      params: { name: 'a' },
    });
    expect(parseAppMessage({ jsonrpc: '2.0', method: 'x', params: [1] })).toBeNull();
    expect(parseAppMessage({ jsonrpc: '2.0', method: 'x', id: { a: 1 } })).toBeNull();
    expect(parseAppMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBeNull();
  });
});
