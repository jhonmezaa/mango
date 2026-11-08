import { INIT_TYPE, PROTOCOL_VERSION, serve, TIMEOUTS } from '@mango/ui-sandbox/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acceptInit, openSandbox, RUNNER_SANDBOX } from './sandboxHost';

const ORIGIN = 'https://d123.cloudfront.net';
const INIT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const open: MessagePort[] = [];
function channel(): MessageChannel {
  const c = new MessageChannel();
  open.push(c.port1, c.port2);
  return c;
}
afterEach(() => {
  for (const port of open.splice(0)) port.close();
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** An `init` as the runner sends it, and the runner's ends of its ports. */
function init(overrides: Record<string, unknown> = {}) {
  const run = channel();
  const stop = channel();
  const app = channel();
  const appContext = channel();
  const reply = channel();
  const data = {
    type: INIT_TYPE,
    version: PROTOCOL_VERSION,
    initId: INIT_ID,
    ports: { run: run.port2, stop: stop.port2, app: app.port2, appContext: appContext.port2 },
    replyPort: reply.port2,
    ...overrides,
  };
  return {
    data,
    ports: [run.port2, stop.port2, app.port2, appContext.port2, reply.port2],
    runner: {
      run: run.port1,
      stop: stop.port1,
      app: app.port1,
      appContext: appContext.port1,
      reply: reply.port1,
    },
  };
}

function event(data: unknown, source: unknown, origin: string, ports: MessagePort[]) {
  return { data, source, origin, ports } as unknown as MessageEvent<unknown>;
}

describe('acceptInit (TM-UI3)', () => {
  const frame = {} as Window;
  const expected = { source: frame, origin: ORIGIN, initId: INIT_ID };

  it('accepts the runner of its iframe, at its origin, with its initId and its ports', () => {
    const { data, ports } = init();
    expect(acceptInit(event(data, frame, ORIGIN, ports), expected)).not.toBeNull();
  });

  it('refuses another window, even with everything else right', () => {
    const { data, ports } = init();
    expect(acceptInit(event(data, {}, ORIGIN, ports), expected)).toBeNull();
    expect(acceptInit(event(data, window, ORIGIN, ports), expected)).toBeNull();
  });

  it.each(['https://sandbox.example.com', 'null', window.location.origin, `${ORIGIN}:443`])(
    'refuses the origin %s',
    (origin) => {
      const { data, ports } = init();
      expect(acceptInit(event(data, frame, origin, ports), expected)).toBeNull();
    },
  );

  it('refuses another initId, another version or another type', () => {
    for (const override of [
      { initId: '1f8fad5b-d9cb-469f-a165-70867728950e' },
      { version: 2 },
      { type: 'init' },
    ]) {
      const { data, ports } = init(override);
      expect(acceptInit(event(data, frame, ORIGIN, ports), expected)).toBeNull();
    }
  });

  it('refuses a port more, a port less or a port with another name', () => {
    const extra = channel();
    const cases = [
      (p: Record<string, MessagePort>) => ({ ...p, callTool: extra.port2 }),
      (p: Record<string, MessagePort>) => ({ run: p.run }),
      (p: Record<string, MessagePort>) => ({ run: p.run, halt: p.stop }),
    ];
    for (const change of cases) {
      const { data, ports } = init();
      const changed = { ...data, ports: change(data.ports) };
      expect(
        acceptInit(event(changed, frame, ORIGIN, [...ports, extra.port2]), expected),
      ).toBeNull();
    }
  });

  it('refuses ports that were not transferred with the message, and extra fields', () => {
    const { data, ports } = init();
    expect(acceptInit(event(data, frame, ORIGIN, ports.slice(0, 2)), expected)).toBeNull();
    const { data: more, ports: morePorts } = init({ token: 'x' });
    expect(acceptInit(event(more, frame, ORIGIN, morePorts), expected)).toBeNull();
  });
});

describe('openSandbox', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  it('frames the runner with its initId, without the SPA origin, and its own sandbox', async () => {
    void openSandbox({ origin: ORIGIN, container, title: 'Vista previa', handshakeMs: 50 }).catch(
      () => undefined,
    );
    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('sandbox')).toBe(RUNNER_SANDBOX);
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe?.src).toMatch(
      /^https:\/\/d123\.cloudfront\.net\/sandbox\.html#initId=[0-9a-f-]{36}$/,
    );
    expect(iframe?.getAttribute('srcdoc')).toBeNull();
    await new Promise((r) => setTimeout(r, 60));
  });

  it('refuses an origin that is not an exact https origin or is its own', async () => {
    for (const origin of ['https://*.cloudfront.net', `${ORIGIN}/`, 'http://evil.example.com']) {
      await expect(openSandbox({ origin, container, title: 't' })).rejects.toMatchObject({
        name: 'ConfigError',
      });
    }
    await expect(
      openSandbox({ origin: window.location.origin, container, title: 't' }),
    ).rejects.toMatchObject({ name: 'ConfigError' });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('gives up after 20 seconds without an init, and removes the iframe', async () => {
    vi.useFakeTimers();
    const pending = openSandbox({ origin: ORIGIN, container, title: 't' });
    // A message from another window is ignored.
    window.dispatchEvent(new MessageEvent('message', { data: init().data, origin: ORIGIN }));
    vi.advanceTimersByTime(TIMEOUTS.handshakeMs);
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('talks to the runner only through its ports once the init is accepted', async () => {
    const pending = openSandbox({ origin: ORIGIN, container, title: 't' });
    const iframe = container.querySelector('iframe');
    const { data, ports, runner } = init();
    // The utility created the initId: read it back from the URL it framed.
    const initId = new URLSearchParams(iframe?.src.split('#')[1]).get('initId');
    const message = { ...data, initId };
    const listeners = vi.spyOn(window, 'removeEventListener');
    window.dispatchEvent(
      Object.assign(new Event('message'), {
        data: message,
        origin: ORIGIN,
        source: iframe?.contentWindow,
        ports,
      }),
    );
    const session = await pending;
    expect(listeners).toHaveBeenCalledWith('message', expect.any(Function));

    serve(runner.run, {
      parse: (arg) => arg as { source: string },
      handle: (request) =>
        Promise.resolve({ ok: request.source === 'x'.repeat(100_000), durationMs: 5 }),
    });
    // A large source crosses (1 MiB bound), the answer is checked.
    await expect(session.run({ kind: 'react', source: 'x'.repeat(100_000) })).resolves.toEqual({
      ok: true,
      durationMs: 5,
    });

    const seen: unknown[] = [];
    session.onEvent((e) => seen.push(e));
    const ask = (value: unknown) =>
      new Promise<unknown>((resolve) => {
        const c = channel();
        c.port1.onmessage = (m: MessageEvent<unknown>) => {
          resolve(m.data);
        };
        runner.reply.postMessage(['CALL', value], [c.port2]);
      });
    expect(await ask({ type: 'height', px: 120 })).toEqual(['RESOLVE', null]);
    expect(await ask({ type: 'callTool', name: 'x' })).toMatchObject([
      'REJECT',
      { name: 'BadRequest' },
    ]);
    expect(seen).toEqual([{ type: 'height', px: 120 }]);

    session.destroy();
    expect(container.querySelector('iframe')).toBeNull();
    await expect(session.run({ kind: 'html', source: '' })).rejects.toMatchObject({
      name: 'Closed',
    });
  });
});

describe('an MCP App in the runner (D125 (3), (4))', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  async function opened() {
    const pending = openSandbox({ origin: ORIGIN, container, title: 't' });
    const iframe = container.querySelector('iframe');
    const { data, ports, runner } = init();
    const initId = new URLSearchParams(iframe?.src.split('#')[1]).get('initId');
    window.dispatchEvent(
      Object.assign(new Event('message'), {
        data: { ...data, initId },
        origin: ORIGIN,
        source: iframe?.contentWindow,
        ports,
      }),
    );
    const session = await pending;
    const ask = (value: unknown) =>
      new Promise<unknown>((resolve) => {
        const c = channel();
        c.port1.onmessage = (m: MessageEvent<unknown>) => {
          resolve(m.data);
        };
        runner.reply.postMessage(['CALL', value], [c.port2]);
      });
    return { session, runner, ask };
  }

  const request = {
    html: '<p>app</p>',
    toolInput: { id: 1 },
    toolResult: { content: [{ type: 'text' as const, text: 'r'.repeat(40_000) }], isError: false },
    displayMode: 'inline' as const,
  };

  it('starts the app and answers its tool calls and display modes through the handlers', async () => {
    const { session, runner, ask } = await opened();
    let started: unknown = null;
    serve(runner.app, {
      parse: (arg) => arg,
      handle: (arg) => {
        started = arg;
        return Promise.resolve({ ok: true });
      },
    });
    const callTool = vi.fn(() =>
      Promise.resolve({
        content: [{ type: 'text' as const, text: 'w'.repeat(30_000) }],
        isError: false,
      }),
    );
    const refused = vi.fn();
    // Before an app runs, the runner's requests get nothing.
    expect(
      await ask({ type: 'app-tool-call', name: 'wit_work_item', arguments: {} }),
    ).toMatchObject(['REJECT', { name: 'NoApp' }]);
    await session.startApp(request, {
      callTool,
      requestDisplayMode: (mode) => (mode === 'pip' ? 'inline' : mode),
      refused,
    });
    expect(started).toEqual(request);
    const answer = (await ask({
      type: 'app-tool-call',
      name: 'wit_work_item',
      arguments: { id: 2 },
    })) as [string, { content: { text: string }[] }];
    expect(callTool).toHaveBeenCalledWith('wit_work_item', { id: 2 });
    expect(answer[0]).toBe('RESOLVE');
    expect(answer[1].content[0]?.text).toHaveLength(30_000);
    expect(await ask({ type: 'app-display-mode', mode: 'pip' })).toEqual([
      'RESOLVE',
      { mode: 'inline' },
    ]);
    expect(await ask({ type: 'app-refused', method: 'ui/message' })).toEqual(['RESOLVE', null]);
    expect(refused).toHaveBeenCalledWith('ui/message');

    let mode: unknown = null;
    serve(runner.appContext, {
      parse: (arg) => arg,
      handle: (arg) => {
        mode = arg;
        return Promise.resolve(null);
      },
    });
    await session.setAppDisplayMode('fullscreen');
    expect(mode).toEqual({ displayMode: 'fullscreen' });
    session.destroy();
  });

  it('gives the app the reason Mango did not make a call', async () => {
    const { session, runner, ask } = await opened();
    serve(runner.app, { parse: (arg) => arg, handle: () => Promise.resolve({ ok: true }) });
    await session.startApp(request, {
      callTool: () => Promise.reject(new Error('sin presupuesto')),
      requestDisplayMode: (mode) => mode,
    });
    expect(await ask({ type: 'app-tool-call', name: 'wit_work_item', arguments: {} })).toEqual([
      'REJECT',
      { name: 'Error', message: 'sin presupuesto' },
    ]);
    session.destroy();
  });
});
