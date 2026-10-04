import { describe, expect, it, vi } from 'vitest';

import { createServerSession } from './serverSession';

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

function setup(...responses: (Response | Error)[]) {
  const fetchImpl = vi.fn<typeof fetch>(() => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { fetchImpl, session: createServerSession('/api', fetchImpl, () => 1_000) };
}

describe('server session (D63)', () => {
  it('hands the refresh token over with the CSRF header, same origin only', async () => {
    const { fetchImpl, session } = setup(new Response(null, { status: 204 }));
    await expect(session.start('access', 'refresh', true)).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/session');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      body: JSON.stringify({ refresh_token: 'refresh', federated: true }),
    });
    expect(init?.headers).toMatchObject({
      'X-Mango-Session': '1',
      Authorization: 'Bearer access',
    });
  });

  it('reports a session the server did not take', async () => {
    const { session } = setup(json(503), new TypeError('network'));
    await expect(session.start('a', 'r', false)).resolves.toBe(false);
    await expect(session.start('a', 'r', false)).resolves.toBe(false);
  });

  it('renews with the cookie alone and never sends a token', async () => {
    const { fetchImpl, session } = setup(
      json(200, { access_token: 'a2', id_token: 'i2', expires_in: 3600, federated: false }),
    );
    await expect(session.renew()).resolves.toEqual({
      kind: 'ok',
      session: { accessToken: 'a2', idToken: 'i2', expiresAt: 3_601_000, federated: false },
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/session/refresh');
    expect(init?.body).toBeNull();
    expect(init?.headers).not.toHaveProperty('Authorization');
  });

  it('tells no session apart from an unknown answer', async () => {
    const { session } = setup(
      new Response(null, { status: 204 }),
      json(401),
      json(503),
      json(429),
      new TypeError('network'),
      json(200, { access_token: '', id_token: 'i', expires_in: 1, federated: false }),
    );
    await expect(session.renew()).resolves.toEqual({ kind: 'none' });
    for (let i = 0; i < 5; i += 1) {
      await expect(session.renew()).resolves.toEqual({ kind: 'unavailable' });
    }
  });

  it('signs out without failing the caller', async () => {
    const { fetchImpl, session } = setup(new Response(null, { status: 204 }), new TypeError('x'));
    await session.end();
    await session.end();
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});
