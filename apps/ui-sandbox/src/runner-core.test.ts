import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TIMEOUTS, type SandboxEvent } from './protocol';
import { fromInner, INNER_INIT, INNER_SANDBOX, MAX_EVENTS, Runner } from './runner-core';

const ORIGIN = 'https://d123.cloudfront.net';
const assets = { bootstrap: 'void 0;', pythonWorker: 'void 0;' };

let container: HTMLElement;
let events: SandboxEvent[];
let runner: Runner;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  events = [];
  runner = new Runner(container, ORIGIN, assets, (e) => events.push(e), [
    'https://a.example.com',
    'https://b.example.com',
  ]);
});
afterEach(() => {
  runner.stop();
  container.remove();
  vi.useRealTimers();
});

function frame(): HTMLIFrameElement {
  const found = container.querySelector('iframe');
  if (!found) throw new Error('no frame');
  return found;
}

/** The port the runner hands the inner frame, and the job it sends on it. */
async function innerPort(): Promise<{ port: MessagePort; job: unknown }> {
  const target = frame();
  return new Promise((resolve) => {
    const spy = vi.fn((message: unknown, _origin: string, transfer: MessagePort[]) => {
      expect(message).toEqual({ type: INNER_INIT });
      const port = transfer[0];
      if (!port) throw new Error('no port');
      port.onmessage = (event: MessageEvent<unknown>) => {
        resolve({ port, job: event.data });
      };
    });
    Object.defineProperty(target.contentWindow, 'postMessage', { value: spy });
    target.dispatchEvent(new Event('load'));
  });
}

describe('Runner', () => {
  it('runs each request in an inner frame of an opaque origin, policy first', async () => {
    const run = runner.run(
      { kind: 'react', source: 'export default () => null' },
      new AbortController().signal,
    );
    const f = frame();
    expect(f.getAttribute('sandbox')).toBe(INNER_SANDBOX);
    expect(INNER_SANDBOX).not.toContain('allow-same-origin');
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(f.srcdoc).toContain(`connect-src ${ORIGIN}/vendor/`);
    const { port, job } = await innerPort();
    expect(job).toEqual({ kind: 'react', source: 'export default () => null' });
    port.postMessage({ type: 'done', ok: true });
    await expect(run).resolves.toMatchObject({ ok: true });
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
  });

  it('gives a Python run the worker and the Pyodide of the mirror', async () => {
    void runner
      .run({ kind: 'python', source: 'print(1)' }, new AbortController().signal)
      .catch(() => undefined);
    const { job } = await innerPort();
    expect(job).toMatchObject({
      kind: 'python',
      pythonWorker: 'void 0;',
      pyodideUrl: `${ORIGIN}/vendor/pyodide/0.26.4/`,
    });
  });

  it('replaces the frame of the previous run, which ends as cancelled', async () => {
    const first = runner.run({ kind: 'html', source: '<p>1</p>' }, new AbortController().signal);
    const before = frame();
    const second = runner.run({ kind: 'html', source: '<p>2</p>' }, new AbortController().signal);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(before.isConnected).toBe(false);
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    runner.stop();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(container.querySelectorAll('iframe')).toHaveLength(0);
  });

  it('destroys the frame when the run times out (50 s)', async () => {
    vi.useFakeTimers();
    const run = runner.run(
      { kind: 'python', source: 'while True: pass' },
      new AbortController().signal,
    );
    vi.advanceTimersByTime(TIMEOUTS.runMs);
    await expect(run).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('destroys the frame when the host aborts', async () => {
    const controller = new AbortController();
    const run = runner.run({ kind: 'html', source: '' }, controller.signal);
    controller.abort();
    await expect(run).rejects.toMatchObject({
      name: 'AbortError',
      message: 'The run was cancelled.',
    });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('never loosens its policy: a looser one needs a new runner', async () => {
    const signal = new AbortController().signal;
    const swallow = () => undefined;
    runner
      .run({ kind: 'html', source: '', connectDomains: ['a.example.com', 'b.example.com'] }, signal)
      .catch(swallow);
    runner
      .run({ kind: 'html', source: '', connectDomains: ['a.example.com'] }, signal)
      .catch(swallow);
    await expect(
      runner.run(
        { kind: 'html', source: '', connectDomains: ['a.example.com', 'b.example.com'] },
        signal,
      ),
    ).rejects.toMatchObject({ name: 'PolicyError', message: 'CSP is being loosened' });
  });

  it('refuses a domain outside its ceiling', async () => {
    await expect(
      runner.run(
        { kind: 'html', source: '', connectDomains: ['evil.example.com'] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'PolicyError' });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('passes on at most a bounded number of well-formed events of the inner frame', async () => {
    const run = runner.run({ kind: 'html', source: '' }, new AbortController().signal);
    const { port } = await innerPort();
    port.postMessage({ type: 'callTool', name: 'delete_everything' });
    port.postMessage({ type: 'complete', durationMs: 1 });
    for (let i = 0; i < MAX_EVENTS + 50; i += 1) port.postMessage({ type: 'height', px: i });
    port.postMessage({ type: 'done', ok: false });
    await expect(run).resolves.toMatchObject({ ok: false });
    expect(events.filter((e) => e.type === 'height')).toHaveLength(MAX_EVENTS);
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(1);
  });
});

describe('fromInner', () => {
  it('cuts long errors and clamps heights instead of trusting them', () => {
    expect(fromInner({ type: 'error', message: 'x'.repeat(5000), line: 2 })).toMatchObject({
      type: 'error',
      line: 2,
    });
    expect(
      (fromInner({ type: 'error', message: 'x'.repeat(5000) }) as { message: string }).message,
    ).toHaveLength(1000);
    expect(fromInner({ type: 'height', px: 1e9 })).toEqual({ type: 'height', px: 100_000 });
    expect(fromInner({ type: 'done', ok: 'yes' })).toBeNull();
    expect(fromInner(null)).toBeNull();
  });
});
