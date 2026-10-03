import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  zGetCatalogResponse,
  zGetReviewsResponse,
  zListGroupsResponse,
  zReadVersionResponse,
} from '@mango/api-client/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { diffDefinitions } from './agentDiff.ts';
import { agents, publishedVersion } from './agents.ts';
import { middleware } from './mockBackend.ts';

const OTHERS_NEW = 'b6t2hd5yq7lc3vpe';
const OWN = 'w4nx2g7ajr5ue6ms';
const FAILED = 'p2ys6ke4c7dq3hzo';

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

function api(path: string, body?: unknown): Promise<Response> {
  return fetch(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function reviews() {
  const response = await api('/agents/reviews');
  expect(response.status).toBe(200);
  return zGetReviewsResponse.parse(await response.json());
}

async function version(agentId: string, number: number) {
  const response = await api(`/agents/${agentId}/versions/${String(number)}`);
  expect(response.status).toBe(200);
  return zReadVersionResponse.parse(await response.json());
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
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

describe('mock agent review', () => {
  it('lists the queue (oldest first) and the history in the generated contract', async () => {
    const { queue, history } = await reviews();
    expect(queue.map((item) => [item.agent_id, item.kind, item.is_author])).toEqual([
      [OTHERS_NEW, 'new', false],
      [OWN, 'new', true],
      ['finops', 'change', false],
    ]);
    expect(queue.every((item) => item.status === 'in_review' && item.changes !== null)).toBe(true);
    expect(new Set(history.map((item) => item.status))).toEqual(
      new Set(['draft', 'failed', 'published', 'retired']),
    );
    // A draft is only listed when a reviewer rejected it, with the reason.
    expect(
      history.filter((item) => item.status === 'draft').every((item) => item.rejection_reason),
    ).toBe(true);
    expect(history.filter((item) => item.retryable).map((item) => item.status)).toEqual(['failed']);
    expect(history.find((item) => item.status === 'retired')?.retire_reason).toBeTruthy();
    expect(history.every((item) => item.changes !== null && item.decided_at !== null)).toBe(true);
  });

  it('computes the diff of a change against the published version', async () => {
    const change = await version('finops', 2);
    expect(change.diff.is_new).toBe(false);
    expect(change.base?.name).toBe('FinOps');
    expect(change.diff.fields.map((field) => field.field)).toEqual([
      'description',
      'role',
      'limits.max_iterations',
    ]);
    expect(change.diff.sets).toEqual([
      {
        field: 'tools',
        added: ['cost-explorer.get_savings_plans_coverage'],
        removed: ['cost-explorer.get_anomalies'],
      },
      { field: 'groups', added: [], removed: ['bu-retail'] },
    ]);
    expect(change.diff.prompt).toEqual([
      { op: ' ', text: 'You are Mango FinOps.' },
      { op: '+', text: 'Before recommending Savings Plans, check the current coverage.' },
      { op: '+', text: 'Always include the annualized saving.' },
    ]);
    expect(change.diff.changes).toBe(7);
    expect((await reviews()).queue.find((item) => item.agent_id === 'finops')?.changes).toBe(7);

    const fresh = await version(OTHERS_NEW, 1);
    expect(fresh.diff.is_new).toBe(true);
    expect(fresh.base).toBeNull();
    expect(fresh.diff.fields).toEqual([]);
    expect(fresh.diff.prompt?.every((line) => line.op === '+')).toBe(true);
  });

  it('diffs prompt lines in order', () => {
    const base = publishedVersion(agents.get('finops') ?? never())?.definition ?? never();
    const prompt = (before: string, after: string) =>
      diffDefinitions({ ...base, system_prompt: before }, { ...base, system_prompt: after }).prompt;
    expect(prompt('a\nb\nc', 'a\nc\nd')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' },
    ]);
    expect(prompt('same', 'same')).toBeNull();
  });

  it('refuses the decisions the API refuses', async () => {
    const own = await version(OWN, 1);
    const approveOwn = await api(`/agents/${OWN}/versions/1/approve`, {
      content_hash: own.content_hash,
    });
    expect(approveOwn.status).toBe(403);
    expect(await errorCode(approveOwn)).toBe('same_approver');
    const rejectOwn = await api(`/agents/${OWN}/versions/1/reject`, { reason: 'x' });
    expect(await errorCode(rejectOwn)).toBe('same_approver');

    expect((await api(`/agents/${OTHERS_NEW}/versions/1/reject`, { reason: '' })).status).toBe(422);
    expect((await api(`/agents/${OTHERS_NEW}/versions/1/reject`, {})).status).toBe(422);
    const stale = await api(`/agents/${OTHERS_NEW}/versions/1/approve`, {
      content_hash: 'f'.repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('version_conflict');
    // Only a failed version can be retried.
    expect(
      (await api(`/agents/${OWN}/versions/1/retry`, { content_hash: own.content_hash })).status,
    ).toBe(409);
    expect((await api(`/agents/${OWN}/versions/9`)).status).toBe(404);
  });

  it('rejects with a reason: the version goes back to its creator as a draft', async () => {
    const response = await api(`/agents/${OTHERS_NEW}/versions/1/reject`, {
      reason: 'Falta el rol.',
    });
    const rejected = zReadVersionResponse.parse(await response.json());
    expect(rejected).toMatchObject({ status: 'draft', rejection_reason: 'Falta el rol.' });
    expect((await reviews()).queue.map((item) => item.agent_id)).not.toContain(OTHERS_NEW);
  });

  it('approves a change and retries a failed publication', async () => {
    const change = await version('finops', 2);
    const approved = zReadVersionResponse.parse(
      await (
        await api('/agents/finops/versions/2/approve', { content_hash: change.content_hash })
      ).json(),
    );
    expect(approved.status).toBe('approved');
    expect(approved.approved_by).not.toBeNull();
    // The published version keeps serving until the provisioner ends.
    expect(approved.agent.published_version).toBe(1);

    const failed = await version(FAILED, 1);
    const retried = zReadVersionResponse.parse(
      await (
        await api(`/agents/${FAILED}/versions/1/retry`, { content_hash: failed.content_hash })
      ).json(),
    );
    expect(retried).toMatchObject({ status: 'approved', failed_step: null });
    // A retry keeps the approver.
    expect(retried.approved_by).toBe(failed.approved_by);

    const { queue, history } = await reviews();
    expect(queue.map((item) => item.agent_id)).not.toContain('finops');
    expect(
      history.filter((item) => item.status === 'approved').map((item) => item.agent_id),
    ).toEqual(expect.arrayContaining(['finops', FAILED]));
  });

  it('serves the catalog and the groups the detail reads', async () => {
    const catalog = zGetCatalogResponse.parse(await (await api('/mcp/catalog')).json());
    const refs = catalog.items.flatMap((item) => item.tools.map((tool) => tool.ref));
    for (const agent of agents.values()) {
      for (const { definition } of agent.versions) {
        for (const tool of definition.tools) expect(refs).toContain(tool);
      }
    }
    const groups = zListGroupsResponse.parse(await (await api('/groups')).json());
    expect(groups.items.map((group) => group.id)).toContain('finops-central');
  });
});

function never(): never {
  throw new Error('missing seed');
}
