import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  zCompleteConsentResponse,
  zConnectMyAccountResponse,
  zListMyConnectionsResponse,
} from '@mango/api-client/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleConnections } from './connections.ts';

let server: Server;
let origin = '';

async function call(method: string, path: string, body?: unknown, token = 'token-a') {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${origin}${path}`, init);
  return { status: response.status, body: JSON.parse(await response.text()) as unknown };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleConnections(req, res, url.pathname, url).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('mock of Mis conexiones and the return', () => {
  it('follows the generated contract from «Conectar» to «Conectado»', async () => {
    const { connections } = zListMyConnectionsResponse.parse(
      (await call('GET', '/me/connections')).body,
    );
    const first = connections[0];
    expect(first?.status).toBe('not_connected');
    const reg = first?.registration_id ?? '';

    const asked = zConnectMyAccountResponse.parse(
      (await call('POST', `/me/connections/${reg}/connect`, {})).body,
    );
    expect(asked.status).toBe('consent_required');
    expect(new URL(asked.authorization_url ?? '').hostname).toBe(
      'bedrock-agentcore.us-east-1.amazonaws.com',
    );

    const notMine = await call('POST', '/oauth/callback', {
      session_id: 'urn:ietf:params:oauth:request_uri:notyours',
    });
    expect(notMine.status).toBe(403);
    // Like AgentCore Identity: only the token that asked for the URL closes it (D100).
    const otherToken = await call(
      'POST',
      '/oauth/callback',
      { session_id: 'urn:ietf:params:oauth:request_uri:abc' },
      'token-b',
    );
    expect(otherToken.status).toBe(403);
    const done = zCompleteConsentResponse.parse(
      (
        await call('POST', '/oauth/callback', {
          session_id: 'urn:ietf:params:oauth:request_uri:abc',
        })
      ).body,
    );
    expect(done.registration_id).toBe(reg);
    // The pending consent is used once.
    expect(
      (await call('POST', '/oauth/callback', { session_id: 'urn:ietf:params:oauth:request_uri:x' }))
        .status,
    ).toBe(410);

    const again = zConnectMyAccountResponse.parse(
      (await call('POST', `/me/connections/${reg}/connect`, {})).body,
    );
    expect(again.status).toBe('already_connected');
    await call('POST', `/me/connections/${reg}/disconnect`, {});
  });

  it('rejects a malformed session id', async () => {
    const bad = await call('POST', '/oauth/callback', { session_id: 'https://evil.example/' });
    expect(bad.status).toBe(422);
  });
});
