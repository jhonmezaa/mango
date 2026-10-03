import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  zGetCatalogResponse,
  zGetModelsResponse,
  zListGroupsResponse,
  zReadVersionResponse,
} from '@mango/api-client/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleAgentBuilder } from './agentBuilder.ts';
import { agents } from './agents.ts';

let server: Server;
let origin = '';

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${origin}${path}`, init);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

const DEFINITION = {
  name: 'Analista LATAM',
  description: 'Analiza el gasto.',
  category: 'FinOps',
  reports_to: 'finops',
  role: 'Analista',
  model: 'mock.model-v1',
  allowed_models: ['mock.model-v1'],
  system_prompt: 'Analiza el gasto.',
  tools: ['cost-explorer.get_cost_and_usage'],
  groups: ['finops-central'],
};

async function createDraft(definition: Record<string, unknown> = DEFINITION) {
  const created = await call('POST', '/agents', { definition });
  expect(created.status).toBe(201);
  return zReadVersionResponse.parse(created.body);
}

beforeAll(async () => {
  // The handler alone: authentication is covered by mockBackend.test.ts.
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleAgentBuilder(req, res, url.pathname, url).then((handled) => {
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

describe('mock agent builder', () => {
  it('answers the reads of the builder with the generated contract', async () => {
    expect(zGetModelsResponse.parse((await call('GET', '/models')).body).items).not.toHaveLength(0);
    const catalog = zGetCatalogResponse.parse((await call('GET', '/mcp/catalog')).body);
    expect(catalog.items.some((item) => !item.enabled)).toBe(true);
    expect(zListGroupsResponse.parse((await call('GET', '/groups')).body).items).not.toHaveLength(
      0,
    );
  });

  it('creates, saves and sends a draft; what was sent can no longer change', async () => {
    const draft = await createDraft();
    expect(draft).toMatchObject({ version: 1, status: 'draft', revision: 1, content_hash: null });
    expect(draft.agent_id).toMatch(/^[a-z2-7]{16}$/);
    const path = `/agents/${draft.agent_id}/versions/1`;

    const stale = await call('PUT', path, { revision: 7, definition: DEFINITION });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'version_conflict' } } });

    const saved = zReadVersionResponse.parse(
      (await call('PUT', path, { revision: 1, definition: { ...DEFINITION, role: 'Senior' } }))
        .body,
    );
    expect(saved).toMatchObject({ revision: 2, definition: { role: 'Senior' } });

    const sent = zReadVersionResponse.parse(
      (await call('POST', `${path}/submit`, { revision: 2 })).body,
    );
    expect(sent.status).toBe('in_review');
    expect(sent.content_hash).toMatch(/^[0-9a-f]{64}$/);

    const locked = await call('PUT', path, { revision: 2, definition: DEFINITION });
    expect(locked).toMatchObject({ status: 409, body: { error: { code: 'version_conflict' } } });
    expect(zReadVersionResponse.parse((await call('GET', path)).body).definition.role).toBe(
      'Senior',
    );
  });

  it('rejects a submission that breaks the rules with their codes, never the content', async () => {
    // Split so secret scanners do not take the fixture for a real key.
    const secret = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const draft = await createDraft({
      name: 'Incompleto',
      model: 'mock.model-v1',
      allowed_models: ['mock.model-v1'],
      system_prompt: `usa ${secret}`,
      tools: ['cost-explorer.get_savings_plans_utilization', 'ec2-operations.stop_instances'],
      groups: ['bu-retail'],
    });
    const rejected = await call('POST', `/agents/${draft.agent_id}/versions/1/submit`, {
      revision: 1,
    });
    expect(rejected.status).toBe(422);
    const body = rejected.body as { error: { code: string }; violations: { code: string }[] };
    expect(body.error.code).toBe('validation_failed');
    expect(body.violations.map((violation) => violation.code).sort()).toEqual([
      'account_data_for_non_central_group',
      'reports_to_required',
      'role_required',
      'secret_detected',
      'write_tool_without_approval',
    ]);
    expect(JSON.stringify(body)).not.toContain(secret);
    // The same codes come with the version, which is still a draft.
    expect(draft.violations?.map((violation) => violation.code).sort()).toEqual(
      body.violations.map((violation) => violation.code).sort(),
    );
  });

  it('refuses a supervisor that reports to the agent', async () => {
    // Savings Plans reports to FinOps: FinOps cannot report to it.
    const finops = agents.get('finops');
    if (!finops) throw new Error('missing seed');
    const created = await call('POST', '/agents/finops/versions');
    const draft = zReadVersionResponse.parse(created.body);
    expect(draft).toMatchObject({ status: 'draft', base_version: 1 });
    expect(draft.base).not.toBeNull();
    const again = await call('POST', '/agents/finops/versions');
    expect(again.status).toBe(409);

    const path = `/agents/finops/versions/${String(draft.version)}`;
    const saved = zReadVersionResponse.parse(
      (
        await call('PUT', path, {
          revision: draft.revision,
          definition: { ...draft.definition, reports_to: 'k3fq7zr2m5xw6n4a' },
        })
      ).body,
    );
    expect(saved.diff.fields).toContainEqual({
      field: 'reports_to',
      before: 'platform',
      after: 'k3fq7zr2m5xw6n4a',
    });
    expect(saved.violations).toContainEqual({
      code: 'reports_to_cycle',
      field: 'reports_to',
      items: ['k3fq7zr2m5xw6n4a'],
    });
  });

  it('validates the definition and stops at five submissions per day', async () => {
    const tooLong = await call('POST', '/agents', {
      definition: { ...DEFINITION, name: 'x'.repeat(41) },
    });
    expect(tooLong).toMatchObject({ status: 422, body: { error: { code: 'invalid_request' } } });
    expect((await call('POST', '/agents', { definition: { name: ' ' } })).status).toBe(422);

    let last = { status: 200, retryAfter: null as string | null };
    for (let attempt = 0; attempt < 6 && last.status === 200; attempt += 1) {
      const draft = await createDraft();
      const sent = await call('POST', `/agents/${draft.agent_id}/versions/1/submit`, {
        revision: 1,
      });
      last = { status: sent.status, retryAfter: sent.headers.get('Retry-After') };
    }
    expect(last.status).toBe(429);
    expect(Number(last.retryAfter)).toBeGreaterThanOrEqual(1);
  });

  it('reopens only a failed publication', async () => {
    const failed = '/agents/p2ys6ke4c7dq3hzo/versions/1';
    const reopened = zReadVersionResponse.parse((await call('POST', `${failed}/reopen`)).body);
    expect(reopened).toMatchObject({ status: 'draft', revision: 2, content_hash: null });
    expect((await call('POST', `${failed}/reopen`)).status).toBe(409);
  });
});
