/**
 * Mock routes of Aprobaciones (D27): requests to confirm write tool calls, their decisions and
 * the policy of each write tool with dual approval. In-memory state in the generated contract
 * (packages/ts/api-client), with strings that contain HTML to check they render as text.
 *
 * Differences with the API, on purpose: the mock has one user (an administrator of central
 * FinOps), so the seeded requests of "other people" are what can be signed here, and running an
 * action only changes its status: nothing is called. The chat creates a request when a message
 * asks for a budget ("crea un presupuesto de 300 para team-a").
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { recordAudit } from './audit.ts';
import { MOCK_USER } from './cognito.ts';
import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TOOL = 'aws-budgets.create_budget';
const OTHER = 'usuario4@example.com';
const OTHER_ADMIN = 'otra.admin@example.com';
const NOTE_MAX_LENGTH = 500;
const ID = /^[0-9a-f]{32}$/;

type Status =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired';

interface Rule {
  condition: 'always' | 'amount' | 'count' | 'environment';
  amount_usd: string | null;
  count: number | null;
  environment: 'prod' | 'staging' | null;
  approvers: number;
  expires_hours: number;
}

interface MockApproval {
  approval_id: string;
  status: Status;
  tier: 'self' | 'approvers';
  reason: 'always' | 'above' | 'below' | 'unknown';
  arguments: Record<string, unknown>;
  rule: Rule;
  signatures: { user_id: string; email: string | null; at: string; note: string | null }[];
  requested_by: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  note: string | null;
  error: string | null;
  conversation_id: string;
}

interface MockChange {
  change_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  before: Rule;
  after: Rule;
  reason: string;
  proposed_by: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}

const WAITING: ReadonlySet<Status> = new Set(['pending', 'approved', 'executing']);

const newId = () => randomBytes(16).toString('hex');
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

let policy: Rule = {
  condition: 'amount',
  amount_usd: '500',
  count: null,
  environment: null,
  approvers: 2,
  expires_hours: 4,
};
let policyVersion = 1;
const approvals = new Map<string, MockApproval>();
const changes: MockChange[] = [];

function seed(): void {
  const add = (item: Partial<MockApproval> & Pick<MockApproval, 'arguments'>) => {
    const approval: MockApproval = {
      approval_id: newId(),
      status: 'pending',
      tier: 'approvers',
      reason: 'above',
      rule: policy,
      signatures: [],
      requested_by: OTHER,
      created_at: iso(-30 * MINUTE_MS),
      expires_at: iso(3.5 * HOUR_MS),
      decided_by: null,
      decided_at: null,
      executed_at: null,
      note: null,
      error: null,
      conversation_id: newId(),
      ...item,
    };
    approvals.set(approval.approval_id, approval);
  };
  add({ arguments: { name: 'plataforma-q4', amount_usd: 12000 } });
  add({
    arguments: { name: 'datos <b>prod</b>', amount_usd: 4200, account_ids: ['123456789012'] },
    signatures: [
      { user_id: OTHER_ADMIN, email: OTHER_ADMIN, at: iso(-10 * MINUTE_MS), note: null },
    ],
    created_at: iso(-3.4 * HOUR_MS),
    expires_at: iso(35 * MINUTE_MS),
  });
  add({
    arguments: { name: 'marketing', amount_usd: 900 },
    requested_by: MOCK_USER,
    created_at: iso(-50 * MINUTE_MS),
  });
  add({
    arguments: { name: 'ventas', amount_usd: 2500 },
    status: 'approved',
    requested_by: MOCK_USER,
    signatures: [
      { user_id: OTHER_ADMIN, email: OTHER_ADMIN, at: iso(-2 * HOUR_MS), note: 'ok' },
      { user_id: OTHER, email: OTHER, at: iso(-HOUR_MS), note: null },
    ],
    decided_by: OTHER,
    decided_at: iso(-HOUR_MS),
    created_at: iso(-3 * HOUR_MS),
  });
  add({
    arguments: { name: 'sandbox', amount_usd: 60000 },
    status: 'rejected',
    decided_by: OTHER_ADMIN,
    decided_at: iso(-20 * HOUR_MS),
    note: 'El riesgo no se justifica <img src=x onerror=alert(1)>',
    created_at: iso(-22 * HOUR_MS),
    expires_at: iso(-18 * HOUR_MS),
  });
  changes.push({
    change_id: newId(),
    status: 'pending',
    before: policy,
    after: { ...policy, amount_usd: '1000', approvers: 1 },
    reason: 'Los presupuestos de hasta USD 1.000 no necesitan a otra persona',
    proposed_by: OTHER_ADMIN,
    created_at: iso(-2 * HOUR_MS),
    expires_at: iso(7 * 24 * HOUR_MS),
    decided_by: null,
    decided_at: null,
    note: null,
  });
}
seed();

function statusOf(item: MockApproval): Status {
  const waits = item.status === 'pending' || item.status === 'approved';
  return waits && Date.parse(item.expires_at) <= Date.now() ? 'expired' : item.status;
}

function out(item: MockApproval) {
  const status = statusOf(item);
  const mine = item.requested_by === MOCK_USER;
  return {
    approval_id: item.approval_id,
    status,
    tier: item.tier,
    tool: TOOL,
    server_name: 'AWS Budgets',
    description: 'Crear un presupuesto mensual de costo en AWS Budgets, sin notificaciones.',
    agent_id: 'finops',
    agent_name: 'FinOps',
    arguments: item.arguments,
    rule: { ...item.rule, reason: item.reason },
    approvals_needed: item.tier === 'approvers' ? item.rule.approvers : 0,
    signatures: item.signatures,
    requested_by: item.requested_by,
    requested_by_email: item.requested_by,
    created_at: item.created_at,
    expires_at: item.expires_at,
    decided_by: item.decided_by,
    decided_by_email: item.decided_by,
    decided_at: item.decided_at,
    executed_at: item.executed_at,
    note: item.note,
    error: item.error,
    conversation_id: mine ? item.conversation_id : null,
    mine,
    can_sign:
      status === 'pending' &&
      item.tier === 'approvers' &&
      !mine &&
      !item.signatures.some((signature) => signature.user_id === MOCK_USER),
  };
}

function audit(event: string, item: MockApproval, extra: Record<string, unknown> = {}): void {
  recordAudit(event, {
    approval_id: item.approval_id,
    tool: TOOL,
    agent: 'finops',
    tier: item.tier,
    requested_by: item.requested_by,
    outcome: 'applied',
    ...extra,
  });
}

/** What the chat calls when the "agent" asks for a budget: the tier comes from the policy. */
export function requestFromChat(conversationId: string, name: string, amount: number) {
  const self = policy.condition === 'amount' && amount <= Number(policy.amount_usd ?? 0);
  const item: MockApproval = {
    approval_id: newId(),
    status: 'pending',
    tier: self ? 'self' : 'approvers',
    reason: policy.condition === 'always' ? 'always' : self ? 'below' : 'above',
    arguments: { name, amount_usd: amount },
    rule: policy,
    signatures: [],
    requested_by: MOCK_USER,
    created_at: iso(),
    expires_at: iso(policy.expires_hours * HOUR_MS),
    decided_by: null,
    decided_at: null,
    executed_at: null,
    note: null,
    error: null,
    conversation_id: conversationId,
  };
  approvals.set(item.approval_id, item);
  audit('approval.request', item, { conversation_id: conversationId });
  return out(item);
}

/** The requests of one conversation, for GET /conversations/{id}. */
export function approvalsOfConversation(conversationId: string) {
  return [...approvals.values()]
    .filter((item) => item.conversation_id === conversationId && item.requested_by === MOCK_USER)
    .map(out);
}

function ruleOut(rule: Rule) {
  return rule;
}

function policiesOut() {
  const pending = changes.find((change) => change.status === 'pending');
  return {
    tools: [
      {
        tool: TOOL,
        server_name: 'AWS Budgets',
        description: 'Crear un presupuesto mensual de costo en AWS Budgets, sin notificaciones.',
        conditions: ['always', 'amount'],
        policy: ruleOut(policy),
        version: policyVersion,
        pending_change_id: pending?.change_id ?? null,
      },
    ],
    changes: changes
      .toSorted((a, b) => b.created_at.localeCompare(a.created_at))
      .map((change) => ({
        change_id: change.change_id,
        tool: TOOL,
        status: change.status,
        before: ruleOut(change.before),
        after: ruleOut(change.after),
        reason: change.reason,
        proposed_by: change.proposed_by,
        proposed_by_email: change.proposed_by,
        created_at: change.created_at,
        expires_at: change.expires_at,
        decided_by: change.decided_by,
        decided_by_email: change.decided_by,
        decided_at: change.decided_at,
        note: change.note,
      })),
  };
}

async function body(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse((await readBody(req)) || '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.length <= NOTE_MAX_LENGTH
    ? value.trim()
    : null;
}

async function decide(
  req: IncomingMessage,
  res: ServerResponse,
  item: MockApproval,
  action: string,
): Promise<void> {
  const payload = await body(req);
  if (payload === null) {
    sendError(res, 422, 'invalid_request', 'invalid body');
    return;
  }
  const status = statusOf(item);
  const mine = item.requested_by === MOCK_USER;
  const close = (to: Status, note: string | null = null) => {
    item.status = to;
    item.decided_by = MOCK_USER;
    item.decided_at = iso();
    item.note = note;
  };
  if (status === 'expired') {
    sendError(res, 410, 'expired', 'the request expired');
    return;
  }
  if (action === 'approve') {
    if (mine) {
      sendError(res, 403, 'own_request', 'another person must approve what you asked for');
      return;
    }
    if (status !== 'pending' || item.tier !== 'approvers') {
      sendError(res, 409, 'version_conflict', 'the request is no longer pending');
      return;
    }
    if (item.signatures.some((signature) => signature.user_id === MOCK_USER)) {
      sendError(res, 409, 'already_signed', 'you already signed');
      return;
    }
    item.signatures.push({
      user_id: MOCK_USER,
      email: MOCK_USER,
      at: iso(),
      note: text(payload.note),
    });
    if (item.signatures.length >= item.rule.approvers) close('approved');
    audit('approval.approve', item, { signatures: item.signatures.length });
  } else if (action === 'reject') {
    const reason = text(payload.reason);
    if (mine) {
      sendError(res, 403, 'own_request', 'cancel your own request instead');
      return;
    }
    if (status !== 'pending' || reason === null) {
      sendError(
        res,
        reason === null ? 422 : 409,
        reason === null ? 'invalid_request' : 'version_conflict',
        'x',
      );
      return;
    }
    close('rejected', reason);
    audit('approval.reject', item);
  } else if (!mine) {
    sendError(res, 404, 'not_found', 'approval not found');
    return;
  } else if (action === 'cancel') {
    if (status !== 'pending' && status !== 'approved') {
      sendError(res, 409, 'version_conflict', 'the request is no longer pending');
      return;
    }
    close('cancelled');
    audit(item.tier === 'self' ? 'approval.self_cancel' : 'approval.cancel', item);
  } else if (action === 'confirm' || action === 'execute') {
    const expected = action === 'confirm' ? 'pending' : 'approved';
    if (status !== expected || (action === 'confirm' && item.tier !== 'self')) {
      sendError(res, 409, 'version_conflict', 'the request is no longer pending');
      return;
    }
    if (action === 'confirm') {
      close('approved');
      audit('approval.self_confirm', item);
    }
    // A budget whose name says so fails, to review that state.
    const fails = /falla/i.test(String(item.arguments.name));
    item.status = fails ? 'failed' : 'executed';
    item.executed_at = iso();
    item.error = fails ? 'already_exists' : null;
    audit('approval.execute', item);
  } else {
    sendError(res, 404, 'not_found', 'Not found');
    return;
  }
  sendJson(res, 200, out(item));
}

async function decideChange(
  req: IncomingMessage,
  res: ServerResponse,
  change: MockChange,
  action: string,
): Promise<void> {
  const payload = await body(req);
  if (payload === null || change.status !== 'pending') {
    sendError(res, 409, 'version_conflict', 'the proposal is already closed');
    return;
  }
  const mine = change.proposed_by === MOCK_USER;
  if (action === 'withdraw') {
    if (!mine) {
      sendError(res, 403, 'forbidden', 'only the proposer can withdraw a proposal');
      return;
    }
    change.status = 'withdrawn';
  } else if (mine) {
    sendError(res, 403, 'same_approver', 'another administrator must decide');
    return;
  } else if (action === 'approve') {
    change.status = 'approved';
    policy = change.after;
    policyVersion += 1;
  } else {
    const reason = text(payload.reason);
    if (reason === null) {
      sendError(res, 422, 'invalid_request', 'invalid fields: reason');
      return;
    }
    change.status = 'rejected';
    change.note = reason;
  }
  change.decided_by = MOCK_USER;
  change.decided_at = iso();
  recordAudit(`approval.policy.${action}`, {
    change_id: change.change_id,
    tool: TOOL,
    outcome: 'applied',
  });
  sendJson(res, 200, policiesOut());
}

async function propose(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = await body(req);
  const amount = payload?.amount_usd;
  const condition = payload?.condition;
  if (
    payload === null ||
    (condition !== 'always' && condition !== 'amount') ||
    (condition === 'amount' && (typeof amount !== 'string' || !(Number(amount) > 0))) ||
    typeof payload.approvers !== 'number' ||
    typeof payload.expires_hours !== 'number' ||
    text(payload.reason) === null
  ) {
    const unsupported = condition === 'count' || condition === 'environment';
    sendError(
      res,
      422,
      unsupported ? 'condition_unsupported' : 'invalid_request',
      'invalid proposal',
    );
    return;
  }
  if (payload.base_version !== policyVersion) {
    sendError(res, 409, 'version_conflict', 'the policy changed; reload');
    return;
  }
  if (changes.some((change) => change.status === 'pending')) {
    sendError(res, 409, 'already_pending', 'this tool already has an open proposal');
    return;
  }
  const change: MockChange = {
    change_id: newId(),
    status: 'pending',
    before: policy,
    after: {
      condition,
      amount_usd: condition === 'amount' ? String(amount) : null,
      count: null,
      environment: null,
      approvers: payload.approvers,
      expires_hours: payload.expires_hours,
    },
    reason: text(payload.reason) ?? '',
    proposed_by: MOCK_USER,
    created_at: iso(),
    expires_at: iso(7 * 24 * HOUR_MS),
    decided_by: null,
    decided_at: null,
    note: null,
  };
  changes.push(change);
  recordAudit('approval.policy.propose', {
    change_id: change.change_id,
    tool: TOOL,
    outcome: 'applied',
  });
  sendJson(res, 201, { change_id: change.change_id });
}

export const handleApprovals: ApiHandler = async (req, res, path, url) => {
  if (!path.startsWith('/approvals')) return false;
  if (path === '/approvals/policies' && req.method === 'GET') {
    sendJson(res, 200, policiesOut());
    return true;
  }
  if (path === `/approvals/policies/${TOOL}/changes` && req.method === 'POST') {
    await propose(req, res);
    return true;
  }
  const changeMatch =
    /^\/approvals\/policies\/changes\/([0-9a-f]{32})\/(approve|reject|withdraw)$/.exec(path);
  if (changeMatch && req.method === 'POST') {
    const change = changes.find((item) => item.change_id === changeMatch[1]);
    if (!change) sendError(res, 404, 'not_found', 'proposal not found');
    else await decideChange(req, res, change, changeMatch[2] ?? '');
    return true;
  }
  if (path === '/approvals' && req.method === 'GET') {
    const conversation = url.searchParams.get('conversation_id');
    if (conversation !== null) {
      sendJson(res, 200, { items: approvalsOfConversation(conversation), can_decide: false });
      return true;
    }
    const pending = url.searchParams.get('view') !== 'resolved';
    const items = [...approvals.values()]
      .filter((item) => item.tier === 'approvers')
      .map(out)
      // Like the API: a request waits until it is run, closed or expired.
      .filter((item) => WAITING.has(item.status) === pending);
    sendJson(res, 200, { items, can_decide: true });
    return true;
  }
  const match = /^\/approvals\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
  if (!match) return false;
  const item = ID.test(match[1] ?? '') ? approvals.get(match[1] ?? '') : undefined;
  if (!item || (item.tier === 'self' && item.requested_by !== MOCK_USER)) {
    sendError(res, 404, 'not_found', 'approval not found');
    return true;
  }
  if (match[2] === undefined && req.method === 'GET') {
    sendJson(res, 200, out(item));
    return true;
  }
  if (match[2] !== undefined && req.method === 'POST') {
    await decide(req, res, item, match[2]);
    return true;
  }
  return false;
};
