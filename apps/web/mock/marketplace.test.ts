import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  zGetAgentResponse,
  zGetAgentsResponse,
  zGetMineResponse,
  zRetireAgentResponse,
} from '@mango/api-client/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents, publishedVersion } from './agents.ts';
import { middleware } from './mockBackend.ts';

let server: Server;
let origin = '';
let token = '';

/** Signs in through the mock managed login (OAuth code + PKCE), like the SSO flow of the app. */
async function signIn(): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const redirectUri = `${origin}/`;
  const authorize = new URL(`${origin}/mock-cognito/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    redirect_uri: redirectUri,
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
      redirect_uri: redirectUri,
    }),
  });
  const tokens = (await response.json()) as { access_token: string };
  return tokens.access_token;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

function retire(agentId: string, body: unknown): Promise<Response> {
  return api(`/agents/${agentId}/retire`, { method: 'POST', body: JSON.stringify(body) });
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
  token = await signIn();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('mock marketplace', () => {
  it('requires a session', async () => {
    for (const path of ['/agents', '/agents/mine']) {
      expect((await fetch(`${origin}/api${path}`)).status, path).toBe(401);
    }
  });

  it('lists the published and retired agents the user can use, by name', async () => {
    const list = zGetAgentsResponse.parse(await (await api('/agents')).json());
    expect(list.items.map((item) => [item.name, item.status])).toEqual([
      ['FinOps', 'published'],
      ['Reportes mensuales', 'retired'],
      ['Savings Plans', 'published'],
    ]);
    // The lock only comes in the detail; the retirement reason is kept as written.
    expect(list.items.every((item) => item.lock_version === null)).toBe(true);
    expect(list.items[1]?.retire_reason).toContain('<i>Sin uso</i>');
    // Never the prompt or the access lists.
    for (const item of list.items) {
      expect(Object.keys(item)).not.toEqual(
        expect.arrayContaining(['system_prompt', 'groups', 'users']),
      );
    }
  });

  it('leaves out the agents that are not shared with the user', async () => {
    const savings = agents.get('k3fq7zr2m5xw6n4a');
    const version = savings ? publishedVersion(savings) : null;
    if (!version) throw new Error('missing seed agent');
    const groups = version.definition.groups;
    version.definition.groups = ['bu-retail'];
    try {
      const list = zGetAgentsResponse.parse(await (await api('/agents')).json());
      expect(list.items.map((item) => item.name)).toEqual(['FinOps', 'Reportes mensuales']);
    } finally {
      version.definition.groups = groups;
    }
  });

  it('lists the own open versions with the quotas', async () => {
    const mine = zGetMineResponse.parse(await (await api('/agents/mine')).json());
    expect(mine.items.map((item) => [item.name, item.status, item.base_version])).toEqual([
      ['Pronósticos', 'in_review', null],
      ['Savings Plans', 'draft', 2],
      ['Resumen semanal', 'draft', null],
    ]);
    expect(mine.items[2]?.rejection_reason).toBe('Falta indicar a quién reporta y el rol.');
    expect(mine.quotas).toEqual({
      drafts: 2,
      max_drafts: 20,
      submissions_today: expect.any(Number) as number,
      max_submissions_per_day: 5,
    });
  });

  it('retires a published agent with a reason and the lock of the detail', async () => {
    const id = 'k3fq7zr2m5xw6n4a';
    const detail = zGetAgentResponse.parse(await (await api(`/agents/${id}`)).json());
    const lock = detail.lock_version ?? 0;

    for (const body of [
      { lock_version: lock },
      { lock_version: lock, reason: '' },
      { lock_version: lock, reason: 'x'.repeat(501) },
      { lock_version: 'one', reason: 'Sin uso' },
      { lock_version: lock, reason: 'Sin uso', extra: true },
    ]) {
      expect((await retire(id, body)).status, JSON.stringify(body)).toBe(422);
    }
    const stale = await retire(id, { lock_version: lock + 1, reason: 'Sin uso' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'version_conflict' } });
    expect((await retire('zzzzzzzzzzzzzzzz', { lock_version: 1, reason: 'x' })).status).toBe(404);

    const response = await retire(id, { lock_version: lock, reason: 'Sin uso <b>real</b>' });
    expect(response.status).toBe(200);
    const retired = zRetireAgentResponse.parse(await response.json());
    expect(retired).toMatchObject({
      id,
      status: 'retired',
      lock_version: lock + 1,
      retire_reason: 'Sin uso <b>real</b>',
    });
    expect(retired.retired_at).not.toBeNull();

    // Already retired: it cannot be retired again, and it moves to the retired agents.
    expect((await retire(id, { lock_version: lock + 1, reason: 'Otra vez' })).status).toBe(409);
    const list = zGetAgentsResponse.parse(await (await api('/agents')).json());
    expect(list.items.find((item) => item.id === id)?.status).toBe('retired');
  });
});
