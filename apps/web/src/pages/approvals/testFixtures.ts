import type { Approval, Policies, PolicyChange, ToolPolicy } from './model';

export const NOW = Date.parse('2026-10-02T12:00:00Z');
export const REQUESTER = 'user-10';
export const XSS = '<img src=x onerror=alert(1)>';

const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

/** A request that needs approvers, as GET /api/approvals lists it for an approver. */
export function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    approval_id: 'a1b2c3d4'.padEnd(32, '0'),
    status: 'pending',
    tier: 'approvers',
    tool: 'aws-budgets.create_budget',
    server_name: 'AWS Budgets',
    description: 'Crear un presupuesto mensual de costo en AWS Budgets, sin notificaciones.',
    agent_id: 'finops',
    agent_name: 'FinOps',
    arguments: { name: 'team-a', amount_usd: 1200 },
    rule: {
      condition: 'amount',
      reason: 'above',
      amount_usd: '500',
      count: null,
      environment: null,
      approvers: 2,
      expires_hours: 4,
    },
    approvals_needed: 2,
    signatures: [],
    requested_by: REQUESTER,
    requested_by_email: 'pide@example.com',
    created_at: iso(-30),
    expires_at: iso(210),
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    executed_at: null,
    note: null,
    error: null,
    conversation_id: null,
    mine: false,
    can_sign: true,
    ...overrides,
  };
}

/** A call below the threshold, as the chat shows it to who asked. */
export function selfApproval(overrides: Partial<Approval> = {}): Approval {
  return approval({
    approval_id: 'f0e1d2c3'.padEnd(32, '0'),
    tier: 'self',
    arguments: { name: 'team-a', amount_usd: 100 },
    rule: {
      condition: 'amount',
      reason: 'below',
      amount_usd: '500',
      count: null,
      environment: null,
      approvers: 1,
      expires_hours: 24,
    },
    approvals_needed: 0,
    conversation_id: 'c'.repeat(32),
    mine: true,
    can_sign: false,
    ...overrides,
  });
}

export function toolPolicy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    tool: 'aws-budgets.create_budget',
    server_name: 'AWS Budgets',
    description: 'Crear un presupuesto mensual de costo en AWS Budgets, sin notificaciones.',
    conditions: ['always', 'amount'],
    policy: {
      condition: 'always',
      amount_usd: null,
      count: null,
      environment: null,
      approvers: 1,
      expires_hours: 24,
    },
    version: 0,
    pending_change_id: null,
    ...overrides,
  };
}

export function policyChange(overrides: Partial<PolicyChange> = {}): PolicyChange {
  return {
    change_id: '9'.repeat(32),
    tool: 'aws-budgets.create_budget',
    status: 'pending',
    before: toolPolicy().policy,
    after: { ...toolPolicy().policy, condition: 'amount', amount_usd: '500', approvers: 2 },
    reason: 'Los presupuestos chicos no necesitan a otra persona',
    proposed_by: 'admin-2',
    proposed_by_email: 'otro.admin@example.com',
    created_at: iso(-60),
    expires_at: iso(60 * 24 * 7),
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    note: null,
    ...overrides,
  };
}

export function policies(overrides: Partial<Policies> = {}): Policies {
  return { tools: [toolPolicy()], changes: [], ...overrides };
}
