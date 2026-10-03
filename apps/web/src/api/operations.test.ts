import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './client';
import { ApiError } from './errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  const client = createApiClient({
    basePath: '/api',
    getAccessToken: () => Promise.resolve('access-token'),
    fetchImpl: fetchMock,
  });
  return { client, fetchMock };
}

const group = { id: 'bu-retail', type: 'area', area: 'retail', description: 'Retail' };
const budgets = {
  period: '2026-10',
  version: 4,
  defaults: { user_monthly_usd: '50.00', agent_monthly_usd: '2000.00' },
  agents: [],
  users: [],
};

describe('client.call (generated operations)', () => {
  it('calls a route by its name with the session token and validates the response', async () => {
    const { client, fetchMock } = setup(jsonResponse({ items: [group] }));
    await expect(client.call('listGroups')).resolves.toEqual({ items: [group] });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/groups');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-token');
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBeUndefined();
  });

  it('validates and encodes path parameters before the request', async () => {
    const agent = {
      id: 'finops',
      status: 'published',
      version: 1,
      lock_version: 1,
      name: 'FinOps',
      description: '',
      category: '',
      icon: 'Money',
      color: 0,
      role: '',
      reports_to: 'platform',
      model: 'm',
      allowed_models: ['m'],
      tools: [],
      published_at: '2026-09-01T00:00:00Z',
      retired_at: null,
      retire_reason: null,
      unavailable_tools: [],
      is_mine: false,
    };
    const { client, fetchMock } = setup(jsonResponse(agent));
    await expect(client.call('getAgent', { path: { agent_id: 'finops' } })).resolves.toEqual(agent);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/agents/finops');

    await expect(
      client.call('getAgent', { path: { agent_id: '../admin/budgets' } }),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_request' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('percent-encodes path values the contract does not constrain', async () => {
    const conversation = {
      conversation_id: 'c1',
      title: 'Gasto',
      agent_id: 'finops',
      messages: [],
    };
    const { client, fetchMock } = setup(jsonResponse(conversation));
    await client.call('getConversation', { path: { conversation_id: 'a/b?c' } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/conversations/a%2Fb%3Fc');
  });

  it('serializes the query and applies the defaults of the contract', async () => {
    const { client, fetchMock } = setup(jsonResponse({ items: [], next_cursor: null }));
    await client.call('adminAudit', { query: { limit: 20, exclude: ['reads'], cursor: null } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/audit?limit=20&exclude=reads');

    await expect(client.call('adminAudit', { query: { limit: 500 } })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends only the fields of the contract in the body', async () => {
    const { client, fetchMock } = setup(jsonResponse(budgets));
    const body = { version: 4, user_monthly_usd: '60.00', agent_monthly_usd: '2000.00' };
    await client.call('putDefaults', { body: { ...body, is_admin: true } as typeof body });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('PUT');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual(body);
  });

  it('rejects a body that does not match the contract without calling the API', async () => {
    const { client, fetchMock } = setup();
    await expect(
      client.call('putDefaults', {
        body: { version: -1, user_monthly_usd: '1', agent_monthly_usd: '1' },
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects responses that do not match the contract', async () => {
    const { client } = setup(
      jsonResponse({ items: [{ id: 'bu-retail' }] }),
      new Response('<html>', { status: 200 }),
    );
    await expect(client.call('listGroups')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client.call('listGroups')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps API errors like the rest of the client', async () => {
    const onError = jsonResponse({ error: { code: 'forbidden', message: 'not allowed' } }, 403);
    const { client } = setup(onError);
    await expect(client.call('listGroups')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('passes the abort signal through', async () => {
    const { client, fetchMock } = setup(jsonResponse({ items: [] }));
    const controller = new AbortController();
    await client.call('listGroups', {}, { signal: controller.signal });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
});
