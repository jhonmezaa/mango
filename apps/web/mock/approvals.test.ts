import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  zApprovalListOutSchema,
  zApprovalOutSchema,
  zPoliciesOutSchema,
} from '@mango/api-client/schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approvalsOfConversation, handleApprovals, requestFromChat } from './approvals.ts';

let server: Server;
let origin = '';

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${origin}${path}`, init);
  const answer: unknown = await response.json();
  return { status: response.status, body: answer };
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

async function list(view: 'pending' | 'resolved') {
  return zApprovalListOutSchema.parse((await call('GET', `/approvals?view=${view}`)).body);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleApprovals(req, res, url.pathname, url).then((handled) => {
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

describe('mock approvals', () => {
  it('answers the lists and the policies with the generated contract', async () => {
    const pending = await list('pending');
    expect(pending.can_decide).toBe(true);
    expect(pending.items.length).toBeGreaterThan(1);
    // Like the API: an approved request waits in the pending list until who asked runs it.
    expect(new Set(pending.items.map((item) => item.status))).toEqual(
      new Set(['pending', 'approved']),
    );
    expect((await list('resolved')).items.map((item) => item.status)).toEqual(['rejected']);
    const policies = zPoliciesOutSchema.parse((await call('GET', '/approvals/policies')).body);
    expect(policies.tools[0]?.conditions).toEqual(['always', 'amount']);
    expect(policies.changes[0]?.status).toBe('pending');
  });

  it('never lets who asked sign, and signs once', async () => {
    const { items } = await list('pending');
    const own = items.find((item) => item.mine);
    const other = items.find((item) => item.can_sign && item.signatures.length === 0);
    if (!own || !other) throw new Error('seed changed');
    const refused = await call('POST', `/approvals/${own.approval_id}/approve`, {});
    expect([refused.status, errorCode(refused.body)]).toEqual([403, 'own_request']);
    const signed = zApprovalOutSchema.parse(
      (await call('POST', `/approvals/${other.approval_id}/approve`, { note: 'ok' })).body,
    );
    expect([signed.status, signed.signatures.length, signed.can_sign]).toEqual([
      'pending',
      1,
      false,
    ]);
    const twice = await call('POST', `/approvals/${other.approval_id}/approve`, {});
    expect(errorCode(twice.body)).toBe('already_signed');
  });

  it('gives the chat a request whose tier follows the policy, and runs a confirmed one', async () => {
    const conversation = 'c'.repeat(32);
    const small = zApprovalOutSchema.parse(requestFromChat(conversation, 'team-a', 100));
    const large = zApprovalOutSchema.parse(requestFromChat(conversation, 'team-b', 900));
    expect([small.tier, small.rule.reason]).toEqual(['self', 'below']);
    expect([large.tier, large.rule.reason]).toEqual(['approvers', 'above']);
    expect(approvalsOfConversation(conversation)).toHaveLength(2);
    // A request above the threshold cannot be self-confirmed.
    expect((await call('POST', `/approvals/${large.approval_id}/confirm`, {})).status).toBe(409);
    const done = zApprovalOutSchema.parse(
      (await call('POST', `/approvals/${small.approval_id}/confirm`, {})).body,
    );
    expect(done.status).toBe('executed');
    expect((await call('POST', `/approvals/${small.approval_id}/confirm`, {})).status).toBe(409);
  });

  it('changes a policy only through a proposal another administrator decides', async () => {
    const before = zPoliciesOutSchema.parse((await call('GET', '/approvals/policies')).body);
    const pending = before.changes.find((change) => change.status === 'pending');
    const tool = before.tools[0];
    if (!pending || !tool) throw new Error('seed changed');
    const blocked = await call('POST', `/approvals/policies/${tool.tool}/changes`, {
      base_version: tool.version,
      condition: 'always',
      approvers: 1,
      expires_hours: 24,
      reason: 'x',
    });
    expect(errorCode(blocked.body)).toBe('already_pending');
    const after = zPoliciesOutSchema.parse(
      (await call('POST', `/approvals/policies/changes/${pending.change_id}/approve`, {})).body,
    );
    expect(after.tools[0]?.policy.amount_usd).toBe('1000');
    expect(after.tools[0]?.version).toBe(tool.version + 1);
    const created = await call('POST', `/approvals/policies/${tool.tool}/changes`, {
      base_version: tool.version + 1,
      condition: 'always',
      approvers: 1,
      expires_hours: 24,
      reason: 'x',
    });
    expect(created.status).toBe(201);
    const { change_id: mine } = created.body as { change_id: string };
    const own = await call('POST', `/approvals/policies/changes/${mine}/approve`, {});
    expect(errorCode(own.body)).toBe('same_approver');
  });
});
