import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { zGetRemoteCatalogResponse } from '@mango/api-client/schemas';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { handleRemoteMcp } from './remoteMcp.ts';

let server: Server;
let origin = '';
const SECRET = 'mock-secret-never-kept';

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as unknown };
}

async function catalog() {
  return zGetRemoteCatalogResponse.parse((await call('GET', '/mcp/remotes')).body);
}

function code(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleRemoteMcp(req, res, url.pathname.replace(/^\/api/, ''), url).then((handled) => {
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

afterEach(() => {
  vi.useRealTimers();
});

describe('mock of the remote MCP services', () => {
  it('answers in the generated contract, with a live and a pending registration', async () => {
    const data = await catalog();
    expect(data.profiles.map((profile) => profile.id)).toEqual(['azure-devops']);
    expect(data.registrations.map((reg) => reg.status).sort()).toEqual(['active', 'pending']);
  });

  it('asks, never keeps the secret, and finishes after an approval of someone else', async () => {
    const asked = await call('POST', '/mcp/remotes/azure-devops/registrations', {
      organization: 'fabrikam',
      tenant_id: '00000000-0000-4000-8000-000000000001',
      client_id: '00000000-0000-4000-8000-000000000002',
      client_secret: SECRET,
      secret_expires_on: inDays(90),
      toolsets: ['wit'],
      groups: ['finops-central'],
      reason: null,
    });
    expect(asked.status).toBe(201);
    expect(asked.text).not.toContain(SECRET);
    const mine = (await catalog()).registrations.find((reg) => reg.organization === 'fabrikam');
    expect(mine?.pending?.own).toBe(true);
    expect(mine?.toolsets).toEqual(['core', 'wit']);
    const approve = await call(
      'POST',
      `/mcp/remotes/registrations/${mine?.id ?? ''}/requests/${mine?.pending?.id ?? ''}/approve`,
      {},
    );
    expect(code(approve.body)).toBe('same_approver');

    const other = (await catalog()).registrations.find(
      (reg) => reg.organization === 'empresa-labs',
    );
    const approved = await call(
      'POST',
      `/mcp/remotes/registrations/${other?.id ?? ''}/requests/${other?.pending?.id ?? ''}/approve`,
      {},
    );
    expect(approved.status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5000);
    const done = (await catalog()).registrations.find((reg) => reg.id === other?.id);
    expect(done?.status).toBe('active');
  });

  it('refuses a duplicate organization and a body with unknown fields', async () => {
    const base = {
      organization: 'EMPRESA',
      tenant_id: '00000000-0000-4000-8000-000000000001',
      client_id: '00000000-0000-4000-8000-000000000002',
      client_secret: SECRET,
      secret_expires_on: inDays(90),
      toolsets: ['wit'],
      groups: ['finops-central'],
      reason: null,
    };
    expect(code((await call('POST', '/mcp/remotes/azure-devops/registrations', base)).body)).toBe(
      'remote_exists',
    );
    const extra = await call('POST', '/mcp/remotes/azure-devops/registrations', {
      ...base,
      organization: 'otra',
      url: 'https://evil.example.com',
    });
    expect(extra.status).toBe(422);
  });
});
