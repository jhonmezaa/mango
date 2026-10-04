import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { middleware } from './mockBackend.ts';

let server: Server;
let origin = '';

/** Tokens of a sign-in through the mock managed login (OAuth code + PKCE). */
async function signIn(): Promise<{ access_token: string; refresh_token: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${origin}/mock-cognito/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    redirect_uri: `${origin}/`,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 's',
  }).toString();
  const redirected = await fetch(authorize, { redirect: 'manual' });
  const code = new URL(redirected.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const response = await fetch(`${origin}/mock-cognito/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: `${origin}/`,
    }),
  });
  return (await response.json()) as { access_token: string; refresh_token: string };
}

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return fetch(`${origin}/api/session${path}`, {
    method,
    headers: { 'X-Mango-Session': '1', Origin: origin, ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const handle = middleware();
  server = createServer((req, res) => {
    handle(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('mock session cookie (D63)', () => {
  it('keeps a session across requests and ends it on sign-out', async () => {
    const tokens = await signIn();
    const started = await call(
      'POST',
      '',
      { Authorization: `Bearer ${tokens.access_token}` },
      { refresh_token: tokens.refresh_token, federated: false },
    );
    expect(started.status).toBe(204);
    const setCookie = started.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^__Host-mango_session=[\w-]{43}; HttpOnly; Max-Age=28800; Path=\//);
    expect(setCookie).toContain('SameSite=strict; Secure');
    expect(setCookie).not.toContain(tokens.refresh_token);
    const cookie = setCookie.split(';', 1)[0] ?? '';

    const renewed = await call('POST', '/refresh', { Cookie: cookie });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get('cache-control')).toBe('no-store');
    const body = (await renewed.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'access_token',
      'expires_in',
      'federated',
      'id_token',
    ]);
    // The new access token works on the API; the cookie alone does not.
    const me = (token: string) =>
      fetch(`${origin}/api/me`, { headers: { Authorization: `Bearer ${token}`, Cookie: cookie } });
    expect((await me(String(body.access_token))).status).toBe(200);
    expect((await fetch(`${origin}/api/me`, { headers: { Cookie: cookie } })).status).toBe(401);

    expect((await call('DELETE', '', { Cookie: cookie })).status).toBe(204);
    const after = await call('POST', '/refresh', { Cookie: cookie });
    expect(after.status).toBe(401);
    expect(after.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('refuses requests without the header or from another origin, and tokens it does not know', async () => {
    const tokens = await signIn();
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const body = { refresh_token: tokens.refresh_token };
    expect((await call('POST', '', { ...auth, 'X-Mango-Session': '0' }, body)).status).toBe(403);
    expect(
      (await call('POST', '', { ...auth, Origin: 'https://evil.example.com' }, body)).status,
    ).toBe(403);
    expect((await call('POST', '', {}, body)).status).toBe(401);
    expect((await call('POST', '', auth, { refresh_token: 'made-up' })).status).toBe(401);
    expect((await call('POST', '/refresh')).status).toBe(401);
  });
});
