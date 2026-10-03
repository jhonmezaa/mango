import i18n from 'i18next';
import { describe, expect, it } from 'vitest';

import '../../i18n';
import { ApiError } from '../../api/errors';
import {
  NO_FILTERS,
  agentsOf,
  approvalErrorKey,
  argumentEntries,
  baseFilter,
  formOf,
  isStale,
  leftText,
  matchesQuick,
  parseAmount,
  parseCount,
  policyAbove,
  policyBelow,
  policySummary,
  replaceApproval,
  ruleOf,
  ruleText,
  sameRule,
  shortId,
  sortApprovals,
} from './model';
import { NOW, approval, selfApproval, toolPolicy } from './testFixtures';

const t = i18n.t.bind(i18n);

describe('approvals model', () => {
  it('shows a random id, never a counter', () => {
    expect(shortId(approval())).toBe('A1B2C3D4');
  });

  it('says why a request fell in its tier, from what the API stored', () => {
    expect(ruleText(t, approval())).toBe(
      'Más de USD 500,00 · 2 aprobadores distintos de quien la pide',
    );
    expect(ruleText(t, selfApproval())).toBe('Hasta USD 500,00 · confirma quien la pide');
    const unknown = approval({
      rule: { ...approval().rule, reason: 'unknown', approvers: 1 },
    });
    expect(ruleText(t, unknown)).toBe(
      'No se pudo determinar el monto · 1 aprobador distinto de quien la pide',
    );
    const always = approval({
      rule: { ...approval().rule, condition: 'always', reason: 'always', amount_usd: null },
    });
    expect(ruleText(t, always)).toBe('Siempre · 2 aprobadores distintos de quien la pide');
  });

  it('describes a policy as the design does', () => {
    const amount = { ...toolPolicy().policy, condition: 'amount' as const, amount_usd: '500' };
    expect(policyBelow(t, amount)).toBe('Hasta USD 500,00');
    expect(policyAbove(t, amount)).toBe('Más de USD 500,00');
    expect(policyBelow(t, toolPolicy().policy)).toBeNull();
    expect(policySummary(t, toolPolicy().policy)).toBe('Siempre: 1 aprobador · vence en 24 h');
    expect(policySummary(t, { ...amount, approvers: 2, expires_hours: 4 })).toBe(
      'Hasta USD 500,00: confirma el usuario · Más de USD 500,00: 2 aprobadores · vence en 4 h',
    );
    const count = { ...toolPolicy().policy, condition: 'count' as const, count: 5 };
    expect([policyBelow(t, count), policyAbove(t, count)]).toEqual([
      'Hasta 5 recursos',
      'Más de 5 recursos',
    ]);
    const env = {
      ...toolPolicy().policy,
      condition: 'environment' as const,
      environment: 'prod' as const,
    };
    expect([policyBelow(t, env), policyAbove(t, env)]).toEqual(['Fuera de prod', 'En prod']);
  });

  it('renders arguments as text, whatever their type', () => {
    const item = approval({
      arguments: { name: 'a', n: 2, on: true, list: ['x'], nested: { k: 1 } },
    });
    expect(argumentEntries(item)).toEqual([
      ['name', 'a'],
      ['n', '2'],
      ['on', 'true'],
      ['list', '["x"]'],
      ['nested', '{"k":1}'],
    ]);
  });

  it('counts down to the expiry', () => {
    expect(leftText(t, approval(), NOW)).toBe('vence en 4 h');
    expect(leftText(t, approval(), NOW + 180 * 60_000)).toBe('vence en 30 min');
    expect(leftText(t, approval(), NOW + 300 * 60_000)).toBe('vencida');
  });

  it('filters by text, agent and quick view', () => {
    const mine = approval({
      approval_id: 'b'.repeat(32),
      can_sign: false,
      agent_id: 'other',
      agent_name: 'Otro',
    });
    const items = [approval(), mine];
    expect(baseFilter(items, { ...NO_FILTERS, query: 'A1B2' })).toEqual([items[0]]);
    expect(baseFilter(items, { ...NO_FILTERS, query: 'create_budget' })).toHaveLength(2);
    expect(baseFilter(items, { ...NO_FILTERS, agent: 'other' })).toEqual([mine]);
    expect(items.filter((item) => matchesQuick(item, 'mine', NOW))).toEqual([items[0]]);
    expect(items.filter((item) => matchesQuick(item, 'soon', NOW))).toEqual([]);
    expect(matchesQuick(approval(), 'soon', NOW + 180 * 60_000)).toBe(true);
    expect(agentsOf(items)).toEqual([
      { id: 'finops', name: 'FinOps' },
      { id: 'other', name: 'Otro' },
    ]);
  });

  it('sorts pending by what expires first and resolved by the newest decision', () => {
    const soon = approval({
      approval_id: '1'.repeat(32),
      expires_at: new Date(NOW + 60_000).toISOString(),
    });
    const later = approval({ approval_id: '2'.repeat(32) });
    expect(sortApprovals([later, soon], 'pending').map((item) => item.approval_id[0])).toEqual([
      '1',
      '2',
    ]);
    const old = approval({
      approval_id: '3'.repeat(32),
      status: 'rejected',
      decided_at: '2026-10-01T10:00:00Z',
    });
    const fresh = approval({
      approval_id: '4'.repeat(32),
      status: 'executed',
      decided_at: '2026-10-02T10:00:00Z',
    });
    expect(sortApprovals([old, fresh], 'resolved').map((item) => item.approval_id[0])).toEqual([
      '4',
      '3',
    ]);
  });

  it('replaces one request of a list', () => {
    const next = approval({ status: 'rejected' });
    expect(replaceApproval([approval(), selfApproval()], next)[0]).toBe(next);
  });

  it('maps failures to its own messages and knows when the request is stale', () => {
    expect(approvalErrorKey(new ApiError(403, 'own_request', 'x'))).toBe(
      'approvals.errors.own_request',
    );
    expect(approvalErrorKey(new ApiError(409, 'whatever', '<b>server text</b>'))).toBe(
      'approvals.errors.version_conflict',
    );
    expect(approvalErrorKey(new ApiError(410, 'expired', 'x'))).toBe('approvals.errors.expired');
    expect(approvalErrorKey(new ApiError(500, 'boom', 'x'))).toBe('approvals.errors.generic');
    expect(approvalErrorKey(new TypeError('network'))).toBe('approvals.errors.generic');
    expect(isStale(new ApiError(409, 'version_conflict', 'x'))).toBe(true);
    expect(isStale(new ApiError(503, 'audit_unavailable', 'x'))).toBe(false);
  });

  it('builds the rule a policy form describes, or nothing when its threshold is invalid', () => {
    const form = formOf(toolPolicy().policy);
    expect(ruleOf(form)).toEqual({ condition: 'always', approvers: 1, expires_hours: 24 });
    expect(ruleOf({ ...form, condition: 'amount', amount: '500,5' })).toEqual({
      condition: 'amount',
      approvers: 1,
      expires_hours: 24,
      amount_usd: '500.5',
    });
    expect(ruleOf({ ...form, condition: 'amount', amount: '0' })).toBeNull();
    expect(ruleOf({ ...form, condition: 'amount', amount: 'abc' })).toBeNull();
    expect(ruleOf({ ...form, condition: 'count', count: '0' })).toBeNull();
    expect(ruleOf({ ...form, condition: 'count', count: '3' })?.count).toBe(3);
    expect(ruleOf({ ...form, condition: 'environment' })?.environment).toBe('prod');
    expect([parseAmount('1.999'), parseAmount('-1'), parseCount('2.5')]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('knows when a proposal changes nothing', () => {
    const current = { ...toolPolicy().policy, condition: 'amount' as const, amount_usd: '500' };
    expect(sameRule(current, { ...current, amount_usd: '500.00' })).toBe(true);
    expect(sameRule(current, { ...current, approvers: 2 })).toBe(false);
    expect(sameRule(current, toolPolicy().policy)).toBe(false);
  });
});
