import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  zAdminAuditResponse,
  zGetAdminGroupsResponse,
  zGetAdminModelsResponse,
  zGetAgentResponse,
  zGetBudgetsResponse,
  zGetBusinessUnitsResponse,
  zGetConversationResponse,
  zGetRequestsResponse,
  zListConversationsResponse,
  zMeResponse,
  zPutAdminModelResponse,
  zRefreshAdminModelsResponse,
  zResolveUsersResponse,
} from '@mango/api-client/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents, contentHash, newAgentId, publishedVersion, ROOT_SUPERVISOR } from './agents.ts';
import { middleware } from './mockBackend.ts';

// Same patterns as mango_core.agents.
const AGENT_ID = /^(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})$/;
const TOOL_REF = /^[a-z0-9][a-z0-9-]{0,47}\.[A-Za-z0-9_-]{1,64}$/;

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

function post(path: string, body: unknown): Promise<Response> {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}

async function json(path: string): Promise<unknown> {
  const response = await api(path);
  expect(response.status, path).toBe(200);
  return response.json();
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

describe('mock backend', () => {
  it('serves the runtime config and leaves other paths to the dev server', async () => {
    const config = (await (await fetch(`${origin}/config.json`)).json()) as Record<string, unknown>;
    expect(config).toMatchObject({ apiBasePath: '/api', clientId: 'mockclient' });
    expect((await fetch(`${origin}/src/main.tsx`)).status).toBe(404);
  });

  it('requires a session for every API route except health', async () => {
    expect((await fetch(`${origin}/api/health`)).status).toBe(200);
    for (const path of ['/me', '/agents/finops', '/admin/budgets', '/conversations']) {
      const response = await fetch(`${origin}/api${path}`);
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: 'unauthorized', message: 'Missing or invalid token' },
      });
    }
  });

  it('answers unknown routes with the error envelope', async () => {
    const response = await api('/does-not-exist');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('follows the generated contract in every domain', async () => {
    expect(zMeResponse.parse(await json('/me'))).toMatchObject({ is_admin: true });
    const list = zListConversationsResponse.parse(await json('/conversations'));
    expect(list.items.length).toBeGreaterThan(0);
    const first = list.items[0]?.conversation_id ?? '';
    expect(
      zGetConversationResponse.parse(await json(`/conversations/${first}`)).messages,
    ).toHaveLength(2);
    expect(zGetBudgetsResponse.parse(await json('/admin/budgets')).agents).toHaveLength(1);
    expect(zGetBusinessUnitsResponse.parse(await json('/admin/business-units')).version).toBe(3);
    expect(zGetRequestsResponse.parse(await json('/admin/mfa-resets')).items).toEqual([]);
    expect(zAdminAuditResponse.parse(await json('/admin/audit')).items.length).toBeGreaterThan(0);
  });

  it('serves the organization tree', async () => {
    // Not parsed with the generated schema: the mock sends `path` as the ancestors of the unit,
    // while the API also includes the unit's own name (at least one item).
    const organization = (await json('/admin/organization')) as { ous: unknown[] };
    expect(organization.ous).toHaveLength(8);
  });

  it('audits a write made in another domain module', async () => {
    const response = await api('/admin/budgets/defaults', {
      method: 'PUT',
      body: JSON.stringify({ version: 1, user_monthly_usd: '60.00', agent_monthly_usd: '2000.00' }),
    });
    expect(response.status).toBe(200);
    expect(zGetBudgetsResponse.parse(await response.json()).version).toBe(2);
    const audit = zAdminAuditResponse.parse(
      await json('/admin/audit?event=settings.budget.updated'),
    );
    expect(audit.items.map((item) => item.detail.outcome)).toEqual(['applied', 'requested']);
  });
});

describe('mock chat with several agents', () => {
  const chat = (body: Record<string, unknown>) =>
    api('/chat', { method: 'POST', body: JSON.stringify({ message: 'hola', ...body }) });
  const code = async (response: Response) =>
    ((await response.json()) as { error: { code: string } }).error.code;
  const idOf = (name: string) => {
    const found = [...agents.values()].find(
      (agent) =>
        agent.versions.at(-1)?.definition.name === name ||
        publishedVersion(agent)?.definition.name === name,
    );
    if (!found) throw new Error(`no mock agent ${name}`);
    return found.agent_id;
  };

  it('says which agent each conversation belongs to', async () => {
    const list = zListConversationsResponse.parse(await json('/conversations'));
    expect(new Set(list.items.map((item) => item.agent_id)).size).toBeGreaterThan(1);
    for (const item of list.items) {
      expect(item.agent_id).toMatch(AGENT_ID);
      const detail = zGetConversationResponse.parse(
        await json(`/conversations/${item.conversation_id}`),
      );
      expect(detail.agent_id).toBe(item.agent_id);
    }
  });

  it('starts a conversation with the agent and the model the client names', async () => {
    const agentId = idOf('Savings Plans');
    const response = await chat({ agent_id: agentId });
    expect(response.status).toBe(200);
    const text = await response.text();
    const conversationId = /"conversation_id":"([A-Za-z0-9_-]+)"/.exec(text)?.[1] ?? '';
    const detail = zGetConversationResponse.parse(await json(`/conversations/${conversationId}`));
    expect(detail.agent_id).toBe(agentId);
    // The conversation keeps its agent.
    const moved = await chat({ conversation_id: conversationId, agent_id: 'finops' });
    expect([moved.status, await code(moved)]).toEqual([409, 'agent_mismatch']);
    const audit = zAdminAuditResponse.parse(await json('/admin/audit?event=agent.invoke'));
    expect(audit.items[0]?.detail).toMatchObject({ agent: agentId, model: 'mock.model-v1' });
  });

  it('only runs a model the published version allows', async () => {
    const allowed = await chat({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
    expect(allowed.status).toBe(200);
    await allowed.text();
    const other = await chat({
      agent_id: idOf('Savings Plans'),
      model: 'us.anthropic.claude-opus-4-7',
    });
    expect([other.status, await code(other)]).toEqual([422, 'model_not_allowed']);
  });

  it('refuses agents that are not published, retired ones and malformed requests', async () => {
    const draft = [...agents.values()].find((agent) => agent.status === 'draft');
    const retired = [...agents.values()].find((agent) => agent.status === 'retired');
    if (!draft || !retired) throw new Error('the mock seeds a draft and a retired agent');
    const unknown = await chat({ agent_id: 'zzzzzzzzzzzzzzzz' });
    expect([unknown.status, await code(unknown)]).toEqual([403, 'forbidden']);
    const unpublished = await chat({ agent_id: draft.agent_id });
    expect([unpublished.status, await code(unpublished)]).toEqual([403, 'forbidden']);
    const gone = await chat({ agent_id: retired.agent_id });
    expect([gone.status, await code(gone)]).toEqual([409, 'agent_retired']);
    for (const body of [
      { agent_id: '../x' },
      { system_prompt: 'x' },
      { tools: [] },
      { model: 7 },
    ]) {
      expect((await chat(body)).status).toBe(422);
    }
  });
});

describe('mock agents', () => {
  it('serves the detail of FinOps in the generated contract', async () => {
    const body = await json('/agents/finops');
    // The raw body: no prompt and no access lists (groups, users) may come with it.
    expect(body).toEqual({
      id: 'finops',
      status: 'published',
      version: 1,
      lock_version: 1,
      name: 'FinOps',
      description:
        'Analiza el gasto de AWS de tu organización o de tu área y propone optimizaciones.',
      category: 'Finanzas',
      icon: 'Money',
      color: 2,
      role: 'Analista FinOps',
      reports_to: 'platform',
      model: 'mock.model-v1',
      allowed_models: ['mock.model-v1', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'],
      tools: [
        'cost-explorer.get_anomalies',
        'cost-explorer.get_cost_and_usage',
        'cost-explorer.get_cost_forecast',
        'cost-explorer.list_accounts_in_scope',
      ],
      published_at: expect.any(String) as string,
      retired_at: null,
      retire_reason: null,
      unavailable_tools: [],
      // Only a flag: who created the agent is never part of the answer.
      is_mine: false,
      cleanup: null,
    });
    expect(zGetAgentResponse.parse(body)).toEqual(body);
  });

  it('only serves published and retired agents', async () => {
    for (const agent of agents.values()) {
      const response = await api(`/agents/${agent.agent_id}`);
      const listed = agent.status !== 'draft';
      expect(response.status, agent.agent_id).toBe(listed ? 200 : 404);
      if (!listed) continue;
      const detail = zGetAgentResponse.parse(await response.json());
      expect(detail.status).toBe(agent.status);
      expect(detail.version).toBe(agent.published_version);
      expect(detail.retired_at).toBe(agent.retired_at);
      expect(detail.retire_reason).toBe(agent.retire_reason);
    }
    expect((await api('/agents/unknown')).status).toBe(404);
  });

  it('seeds every state the marketplace screens show', () => {
    const versions = [...agents.values()].flatMap((agent) => agent.versions);
    expect(new Set(versions.map((version) => version.status))).toEqual(
      new Set(['draft', 'in_review', 'published', 'failed', 'superseded', 'retired']),
    );
    expect(new Set([...agents.values()].map((agent) => agent.status))).toEqual(
      new Set(['draft', 'published', 'retired']),
    );
  });

  it('keeps the store consistent with the backend model', () => {
    for (const agent of agents.values()) {
      expect(agent.agent_id).toMatch(AGENT_ID);
      expect(agent.latest_version).toBe(agent.versions.length);
      expect(publishedVersion(agent)?.status).toBe(
        agent.status === 'published' ? 'published' : undefined,
      );
      for (const version of agent.versions) {
        const { definition } = version;
        // A version is frozen when it is sent to review: from then on it has a hash.
        expect(version.content_hash).toBe(
          version.status === 'draft' ? null : contentHash(definition),
        );
        const supervisor = definition.reports_to;
        expect(
          supervisor === null || supervisor === ROOT_SUPERVISOR || agents.has(supervisor),
        ).toBe(true);
        expect(supervisor).not.toBe(agent.agent_id);
        for (const tool of definition.tools) expect(tool).toMatch(TOOL_REF);
        expect(definition.tools).toEqual([...definition.tools].sort());
        expect(definition.allowed_models).toContain(definition.model);
      }
    }
  });

  it('generates random ids in the backend format', () => {
    const ids = new Set(Array.from({ length: 50 }, newAgentId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{16}$/);
  });

  it('hashes a definition regardless of key order', () => {
    const definition = publishedVersion(agents.get('finops') ?? never())?.definition ?? never();
    const reversed = Object.fromEntries(Object.entries(definition).reverse()) as typeof definition;
    expect(contentHash(reversed)).toBe(contentHash(definition));
    expect(contentHash({ ...definition, name: 'Otro' })).not.toBe(contentHash(definition));
  });
});

function never(): never {
  throw new Error('missing seed');
}

describe('mock brains', () => {
  const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
  const put = (id: string, body: unknown) =>
    api(`/admin/models/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });

  it('serves every model status in the generated contract', async () => {
    const catalog = zGetAdminModelsResponse.parse(await json('/admin/models'));
    expect(new Set(catalog.items.map((item) => item.status))).toEqual(
      new Set(['enabled', 'available', 'disabled', 'noaccess']),
    );
    const byDefault = catalog.items.filter((item) => item.is_default);
    expect(byDefault).toHaveLength(1);
    // The agents that use a model come from the agents of the mock.
    expect(byDefault[0]?.agents.length).toBeGreaterThan(0);
  });

  it('enables, reprices and disables a model with the catalog version', async () => {
    const { version } = zGetAdminModelsResponse.parse(await json('/admin/models'));
    const enable = { version, enabled: true, input_usd: '0.80', output_usd: '4' };
    expect((await put(HAIKU, { ...enable, version: version - 1 })).status).toBe(409);
    expect((await put(HAIKU, { ...enable, input_usd: '0' })).status).toBe(422);
    expect((await put(HAIKU, { ...enable, extra: true })).status).toBe(422);
    expect((await put('us.unknown.model', enable)).status).toBe(404);

    const enabled = zPutAdminModelResponse.parse(await (await put(HAIKU, enable)).json());
    expect(enabled.version).toBe(version + 1);
    expect(enabled.items.find((item) => item.id === HAIKU)).toMatchObject({
      status: 'enabled',
      input_usd: '0.8',
      output_usd: '4',
    });

    const disabled = zPutAdminModelResponse.parse(
      await (await put(HAIKU, { version: version + 1, enabled: false, reason: ' Prueba ' })).json(),
    );
    expect(disabled.items.find((item) => item.id === HAIKU)).toMatchObject({
      status: 'disabled',
      disabled_reason: 'Prueba',
    });
    const byDefault = disabled.items.find((item) => item.is_default)?.id ?? '';
    const refused = await put(byDefault, { version: version + 2, enabled: false });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'default_model' } });

    const audit = zAdminAuditResponse.parse(await json('/admin/audit?event=settings.model.'));
    expect(audit.items.map((item) => item.event)).toEqual([
      'settings.model.disabled',
      'settings.model.disabled',
      'settings.model.enabled',
      'settings.model.enabled',
    ]);
  });

  it('finds new models on the first refresh only', async () => {
    const before = zGetAdminModelsResponse.parse(await json('/admin/models'));
    const refresh = () => api('/admin/models/refresh', { method: 'POST', body: '{}' });
    const first = zRefreshAdminModelsResponse.parse(await (await refresh()).json());
    expect(first.items).toHaveLength(before.items.length + 1);
    expect(first.refreshed_at).not.toBe(before.refreshed_at);
    const second = zRefreshAdminModelsResponse.parse(await (await refresh()).json());
    expect(second.items).toHaveLength(first.items.length);
    expect((await api('/admin/models/refresh', { method: 'POST', body: '{"x":1}' })).status).toBe(
      422,
    );
  });

  it('follows the groups contract through a proposal, a decision and a description', async () => {
    const before = zGetAdminGroupsResponse.parse(await json('/admin/groups'));
    expect(before.items.map((group) => group.id)).toContain('finops-central');
    expect(before.items.find((group) => group.id === 'finops-central')?.system).toBe(true);
    expect(before.changes.some((change) => change.status === 'expired')).toBe(true);

    // The server-side rules the screen relies on.
    const refusals: [Record<string, unknown>, number, string][] = [
      [
        { kind: 'create', group_id: 'mango-admin', type: 'general', reason: 'x' },
        422,
        'reserved_name',
      ],
      [
        { kind: 'create', group_id: 'seguridad', type: 'general', reason: 'x' },
        409,
        'group_exists',
      ],
      [
        {
          kind: 'update',
          group_id: 'plataforma-sre',
          type: 'general',
          base_version: 0,
          reason: 'x',
        },
        409,
        'central_in_use',
      ],
      [{ kind: 'delete', group_id: 'bu-lead', base_version: 0, reason: 'x' }, 422, 'system_group'],
      [
        { kind: 'create', group_id: 'nuevo', type: 'general', reason: 'x', members: [] },
        422,
        'invalid_request',
      ],
    ];
    for (const [body, status, code] of refusals) {
      const refused = await post('/admin/groups/changes', body);
      expect(refused.status, code).toBe(status);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(code);
    }

    const created = await post('/admin/groups/changes', {
      kind: 'create',
      group_id: 'datos',
      type: 'area',
      area: 'retail',
      description: 'Equipo de datos',
      reason: 'Nuevo equipo',
    });
    expect(created.status).toBe(201);
    const { change_id: own } = (await created.json()) as { change_id: string };
    // Whoever proposes cannot approve; they withdraw.
    expect((await post(`/admin/groups/changes/${own}/approve`, {})).status).toBe(403);
    const withdrawn = await post(`/admin/groups/changes/${own}/withdraw`, {});
    expect(zGetAdminGroupsResponse.parse(await withdrawn.json()).items).toHaveLength(
      before.items.length,
    );

    const theirs = before.changes.find(
      (change) => change.status === 'pending' && change.group_id === 'finanzas-lideres',
    );
    const approved = await post(`/admin/groups/changes/${theirs?.change_id ?? ''}/approve`, {});
    expect(approved.status).toBe(200);
    const after = zGetAdminGroupsResponse.parse(await approved.json());
    expect(after.items.find((group) => group.id === 'finanzas-lideres')).toMatchObject({
      type: 'area',
      area: 'finanzas',
      version: 1,
    });

    const described = await api('/admin/groups/bu-retail/description', {
      method: 'PUT',
      body: JSON.stringify({ version: 0, description: 'Retail y compras' }),
    });
    expect(described.status).toBe(200);
    expect(
      zGetAdminGroupsResponse
        .parse(await described.json())
        .items.find((group) => group.id === 'bu-retail'),
    ).toMatchObject({ description: 'Retail y compras', version: 1 });
  });

  it('resolves people by email and back with the directory contract', async () => {
    const id = '00000000-0000-4000-8000-000000000002';
    const response = await post('/directory/users/resolve', {
      emails: [' Usuario2@Empresa.com ', 'nadie@empresa.com'],
      ids: [id, 'unknown-id'],
    });
    expect(response.status).toBe(200);
    expect(zResolveUsersResponse.parse(await response.json())).toEqual({
      users: [{ id, email: 'usuario2@empresa.com' }],
      emails_not_found: ['nadie@empresa.com'],
      ids_not_found: ['unknown-id'],
    });
    for (const body of [{}, { emails: ['not-an-email'] }, { ids: ['a b'] }, { other: [] }]) {
      expect((await post('/directory/users/resolve', body)).status).toBe(422);
    }
    // The audit event carries counts and the identifiers found, never the emails asked for.
    const audit = zAdminAuditResponse.parse(await json('/admin/audit?limit=50'));
    const event = audit.items.find((item) => item.event === 'directory.lookup');
    expect(event?.detail).toMatchObject({ emails: 2, ids: 2, emails_found: 1, ids_found: 1 });
    expect(JSON.stringify(event?.detail)).not.toContain('empresa.com');
  });
});
