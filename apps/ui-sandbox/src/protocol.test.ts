import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  call,
  isSandboxOrigin,
  LIMITS,
  parseRunRequest,
  parseSandboxEvent,
  serve,
  shapeError,
  TIMEOUTS,
} from './protocol';

const open: MessagePort[] = [];
function channel(): MessageChannel {
  const c = new MessageChannel();
  open.push(c.port1, c.port2);
  return c;
}
afterEach(() => {
  for (const port of open.splice(0)) port.close();
  vi.useRealTimers();
});

describe('shapeError (the bounds of every value that crosses)', () => {
  it('lets small JSON-pure values through', () => {
    expect(shapeError({ a: [1, 'x', null, true], b: { c: 2 } })).toBeNull();
  });

  it.each([
    ['more than 32 entries', Array.from({ length: LIMITS.entries + 1 }, () => 1)],
    [
      'more than 32 keys',
      Object.fromEntries(Array.from({ length: LIMITS.entries + 1 }, (_, i) => [`k${i}`, i])),
    ],
    [
      'nested deeper than 8',
      Array.from({ length: LIMITS.depth + 1 }).reduce<unknown>((inner) => [inner], 1),
    ],
    ['a string over 4096', 'x'.repeat(LIMITS.stringLength + 1)],
    ['a key over 4096', { ['k'.repeat(LIMITS.stringLength + 1)]: 1 }],
    ['over 16 KiB', Array.from({ length: 8 }, () => 'x'.repeat(4000))],
    ['a function', { f: () => 1 }],
    ['a class instance', { d: new Date() }],
    ['a port', { p: new MessageChannel().port1 }],
    ['NaN', { n: Number.NaN }],
    ['undefined', { u: undefined }],
  ])('refuses %s', (_, value) => {
    expect(shapeError(value)).not.toBeNull();
  });

  it('refuses more than 256 values even when each container is small', () => {
    const value = Array.from({ length: 30 }, () => Array.from({ length: 9 }, () => 0));
    expect(shapeError(value)).toBe('too many values');
  });

  it('lets only the named large strings reach 1 MiB, and not beyond', () => {
    const source = 'x'.repeat(200_000);
    expect(shapeError({ source })).not.toBeNull();
    expect(shapeError({ source }, ['source'])).toBeNull();
    expect(shapeError({ source: 'x'.repeat(LIMITS.sourceLength + 1) }, ['source'])).not.toBeNull();
    expect(shapeError({ other: source }, ['source'])).not.toBeNull();
  });
});

describe('parseRunRequest', () => {
  it('accepts the three kinds', () => {
    for (const kind of ['html', 'react', 'python']) {
      expect(parseRunRequest({ kind, source: 'x' })).toEqual({ kind, source: 'x' });
    }
  });

  it.each([
    ['an unknown kind', { kind: 'javascript', source: 'x' }],
    ['no source', { kind: 'html' }],
    ['an unknown field', { kind: 'html', source: 'x', token: 'secret' }],
    ['domains that are not strings', { kind: 'html', source: 'x', connectDomains: [1] }],
    ['not an object', ['html', 'x']],
  ])('refuses %s', (_, value) => {
    expect(() => parseRunRequest(value)).toThrow(/run:/);
  });
});

describe('parseSandboxEvent (what the host accepts from the runner)', () => {
  it('accepts the closed list', () => {
    expect(parseSandboxEvent({ type: 'status', phase: 'running' })).not.toBeNull();
    expect(parseSandboxEvent({ type: 'error', message: 'x', line: 3 })).not.toBeNull();
    expect(parseSandboxEvent({ type: 'complete', durationMs: 10 })).not.toBeNull();
    expect(parseSandboxEvent({ type: 'height', px: 300 })).not.toBeNull();
    expect(parseSandboxEvent({ type: 'csp-violation', directive: 'connect-src' })).not.toBeNull();
  });

  it.each([
    { type: 'callTool', name: 'x' },
    { type: 'status', phase: 'hacking' },
    { type: 'status', phase: 'running', extra: 1 },
    { type: 'height', px: -1 },
    { type: 'height', px: 1.5 },
    { type: 'csp-violation', directive: 'connect-src; x' },
    { type: 'error', message: 'x'.repeat(LIMITS.stringLength + 1) },
  ])('drops %j', (value) => {
    expect(parseSandboxEvent(value)).toBeNull();
  });
});

describe('RPC over MessagePorts (CALL, RESOLVE, REJECT, ABORT)', () => {
  it('resolves with the answer', async () => {
    const c = channel();
    serve(c.port1, { parse: (a) => a as number, handle: (n) => Promise.resolve(n * 2) });
    await expect(call(c.port2, 21)).resolves.toBe(42);
  });

  it('rejects with only the name and message of the error', async () => {
    const c = channel();
    serve(c.port1, {
      parse: (a) => a,
      handle: () => Promise.reject(Object.assign(new Error('boom'), { name: 'Nope', secret: 1 })),
    });
    await expect(call(c.port2, null)).rejects.toMatchObject({ name: 'Nope', message: 'boom' });
  });

  it('refuses a call that is too large before sending it', async () => {
    const c = channel();
    const handle = vi.fn(() => Promise.resolve(null));
    serve(c.port1, { parse: (a) => a, handle });
    await expect(call(c.port2, 'x'.repeat(LIMITS.stringLength + 1))).rejects.toMatchObject({
      name: 'BadRequest',
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('refuses an answer that is too large', async () => {
    const c = channel();
    serve(c.port1, { parse: (a) => a, handle: () => Promise.resolve('x'.repeat(5000)) });
    await expect(call(c.port2, null)).rejects.toMatchObject({ name: 'BadResponse' });
  });

  it('drops messages that are not a CALL with one reply port', async () => {
    const c = channel();
    const handle = vi.fn(() => Promise.resolve(null));
    serve(c.port1, { parse: (a) => a, handle });
    c.port2.postMessage(['CALL', 1]); // no reply port
    const extra = channel();
    c.port2.postMessage(['RUN', 1], [extra.port2]);
    await new Promise((r) => setTimeout(r, 20));
    expect(handle).not.toHaveBeenCalled();
  });

  it('aborts the handler when the caller aborts', async () => {
    const c = channel();
    let aborted = false;
    serve(c.port1, {
      parse: (a) => a,
      handle: (_, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve(null);
          });
        }),
    });
    const controller = new AbortController();
    const pending = call(c.port2, null, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
  });

  it('times out after 30 seconds by default', async () => {
    vi.useFakeTimers();
    const c = channel();
    serve(c.port1, { parse: (a) => a, handle: () => new Promise(() => undefined) });
    const pending = call(c.port2, null);
    vi.advanceTimersByTime(TIMEOUTS.callMs);
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('isSandboxOrigin', () => {
  it('takes an exact https origin', () => {
    expect(isSandboxOrigin('https://d123.cloudfront.net', false)).toBe(true);
  });

  it.each([
    'https://d123.cloudfront.net/',
    'https://*.cloudfront.net',
    'https://[::1]',
    'https://d123.cloudfront.net/sandbox.html',
    'https://user@d123.cloudfront.net',
    'http://d123.cloudfront.net',
    'http://localhost:4601',
    'javascript:alert(1)',
    'null',
  ])('refuses %s', (value) => {
    expect(isSandboxOrigin(value, false)).toBe(false);
  });

  it('takes the loopback over http only when allowed', () => {
    expect(isSandboxOrigin('http://127.0.0.1:4601', true)).toBe(true);
    expect(isSandboxOrigin('http://example.com', true)).toBe(false);
  });
});
