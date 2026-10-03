import type { TFunction } from 'i18next';
import type { z } from 'zod';

import type {
  zApprovalListOutSchema,
  zApprovalOutSchema,
  zPoliciesOutSchema,
  zPolicyChangeOutSchema,
  zPolicyRuleSchema,
  zToolPolicyOutSchema,
} from '@mango/api-client/schemas';

import { ApiError } from '../../api/errors';
import type { BadgeTone } from '../../components/Badge';
import { formatUsd } from '../../lib/format';

// Pure helpers of Aprobaciones (design approvals.jsx and policies.jsx). Everything here reads
// the contract of /api/approvals. Nothing decides: the API authorizes every action, and what a
// request shows (tool, arguments, rule) is what the API stored, never the model's text (R3).

export type Approval = z.output<typeof zApprovalOutSchema>;
export type ApprovalList = z.output<typeof zApprovalListOutSchema>;
export type Policies = z.output<typeof zPoliciesOutSchema>;
export type ToolPolicy = z.output<typeof zToolPolicyOutSchema>;
export type PolicyRule = z.output<typeof zPolicyRuleSchema>;
export type PolicyChange = z.output<typeof zPolicyChangeOutSchema>;
export type Status = Approval['status'];
export type Condition = PolicyRule['condition'];

export const NOTE_MAX_LENGTH = 500;
export const QUERY_MAX_LENGTH = 80;
export const EXPIRY_HOURS = [1, 4, 24, 48, 72] as const;
export const APPROVER_COUNTS = [1, 2, 3] as const;
export const ENVIRONMENTS = ['prod', 'staging'] as const;
export const CONDITIONS: readonly Condition[] = ['always', 'amount', 'count', 'environment'];
export const REJECT_REASONS = ['window', 'context', 'risk', 'staging'] as const;
const MINUTE_MS = 60_000;

export const STATUS_TONE: Record<Status, BadgeTone> = {
  pending: 'amber',
  approved: 'blue',
  executing: 'blue',
  executed: 'green',
  failed: 'red',
  rejected: 'red',
  cancelled: 'neutral',
  expired: 'neutral',
};

/** Public ids are random (never incremental): the design's `APR-208` becomes 8 characters. */
export function shortId(approval: Pick<Approval, 'approval_id'>): string {
  return approval.approval_id.slice(0, 8).toUpperCase();
}

export function minutesLeft(approval: Pick<Approval, 'expires_at'>, now: number): number {
  return Math.round((Date.parse(approval.expires_at) - now) / MINUTE_MS);
}

/** Still waiting for a decision (the API already answers `expired` once the time is up). */
export function isWaiting(approval: Approval): boolean {
  return approval.status === 'pending';
}

/** Design: a request can still expire while it waits to be signed or to be run. */
export function canExpire(approval: Approval): boolean {
  return approval.status === 'pending' || approval.status === 'approved';
}

/** Approved and waiting for who asked: only that person runs it (design «Listas para ejecutar»). */
export function isReadyForMe(approval: Approval): boolean {
  return approval.status === 'approved' && approval.mine;
}

/**
 * The approvers already approved it at some point (design `approvedOnce`). An expired request
 * says so through its signatures: the API keeps no other trace.
 */
export function wasApproved(approval: Approval): boolean {
  if (approval.tier !== 'approvers') return false;
  if (approval.status === 'expired') {
    return approval.signatures.length >= approval.approvals_needed;
  }
  return ['approved', 'executing', 'executed', 'failed'].includes(approval.status);
}

export function leftText(t: TFunction, approval: Approval, now: number): string {
  const left = minutesLeft(approval, now);
  if (left <= 0) return t('approvals.left.expired');
  return left < 60
    ? t('approvals.left.minutes', { count: left })
    : t('approvals.left.hours', { count: Math.round(left / 60) });
}

/** Who to show for a person: the email the API stored, else the id. */
export function personOf(email: string | null | undefined, id: string | null | undefined): string {
  return email ?? id ?? '';
}

function thresholdAbove(t: TFunction, rule: PolicyRule | Approval['rule']): string {
  if (rule.condition === 'amount' && rule.amount_usd) {
    return t('approvals.rule.aboveAmount', { amount: formatUsd(rule.amount_usd) });
  }
  if (rule.condition === 'count' && rule.count != null) {
    return t('approvals.rule.aboveCount', { count: rule.count });
  }
  if (rule.condition === 'environment' && rule.environment) {
    return t('approvals.rule.inEnvironment', { environment: rule.environment });
  }
  return t('approvals.rule.always');
}

function thresholdBelow(t: TFunction, rule: PolicyRule | Approval['rule']): string | null {
  if (rule.condition === 'amount' && rule.amount_usd) {
    return t('approvals.rule.belowAmount', { amount: formatUsd(rule.amount_usd) });
  }
  if (rule.condition === 'count' && rule.count != null) {
    return t('approvals.rule.belowCount', { count: rule.count });
  }
  if (rule.condition === 'environment' && rule.environment) {
    return t('approvals.rule.outOfEnvironment', { environment: rule.environment });
  }
  return null;
}

/** Design `polText` / `polBelow`: when a policy asks for approvers and when the user confirms. */
export function policyAbove(t: TFunction, rule: PolicyRule): string {
  return thresholdAbove(t, rule);
}
export function policyBelow(t: TFunction, rule: PolicyRule): string | null {
  return thresholdBelow(t, rule);
}

/** Design `polSummary`: one line for a policy, used in the proposals. */
export function policySummary(t: TFunction, rule: PolicyRule): string {
  const below = thresholdBelow(t, rule);
  return (
    (below ? t('approvals.policies.summary.below', { when: below }) : '') +
    t('approvals.policies.summary.above', {
      when: thresholdAbove(t, rule),
      count: rule.approvers,
      hours: rule.expires_hours,
    })
  );
}

/** Design `approvalTier(...).rule`: why this request fell in its tier, from what the API stored. */
export function ruleText(t: TFunction, approval: Approval): string {
  const { rule } = approval;
  if (approval.tier === 'self') {
    return t('approvals.rule.join', {
      when: thresholdBelow(t, rule) ?? t('approvals.rule.always'),
      who: t('approvals.rule.self'),
    });
  }
  const when =
    rule.reason === 'unknown'
      ? t(`approvals.rule.unknown.${rule.condition}`)
      : thresholdAbove(t, rule);
  return t('approvals.rule.join', {
    when,
    who: t('approvals.rule.approvers', { count: rule.approvers }),
  });
}

/** An argument as text: scalars as they are, anything else as JSON. Always rendered as text. */
export function argumentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function argumentEntries(approval: Approval): [string, string][] {
  return Object.entries(approval.arguments).map(([key, value]) => [key, argumentText(value)]);
}

export type Quick = 'all' | 'mine' | 'soon' | 'run';
export const QUICK: readonly Quick[] = ['all', 'mine', 'soon', 'run'];

export interface Filters {
  query: string;
  quick: Quick;
  agent: string;
}
export const NO_FILTERS: Filters = { query: '', quick: 'all', agent: 'all' };

export function hasFilters(filters: Filters): boolean {
  return filters.query.trim() !== '' || filters.quick !== 'all' || filters.agent !== 'all';
}

export function matchesQuick(approval: Approval, quick: Quick, now: number): boolean {
  if (quick === 'mine') return approval.can_sign;
  if (quick === 'soon') {
    const left = minutesLeft(approval, now);
    return canExpire(approval) && left > 0 && left < 60;
  }
  if (quick === 'run') return isReadyForMe(approval);
  return true;
}

/** Search and agent filter, without the quick view (its counters are computed on this). */
export function baseFilter(items: readonly Approval[], filters: Filters): Approval[] {
  const query = filters.query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filters.agent === 'all' || item.agent_id === filters.agent) &&
      (!query ||
        `${shortId(item)} ${item.approval_id} ${item.description} ${item.tool}`
          .toLowerCase()
          .includes(query)),
  );
}

/** Design: pending by urgency (what expires first), resolved newest first. */
export function sortApprovals(
  items: readonly Approval[],
  view: 'pending' | 'resolved',
): Approval[] {
  const key = (item: Approval) =>
    view === 'pending'
      ? Date.parse(item.expires_at)
      : -Date.parse(item.decided_at ?? item.created_at);
  return items.toSorted((a, b) => key(a) - key(b));
}

/** Agents that have a request in the list, for the filter. */
export function agentsOf(items: readonly Approval[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const item of items) seen.set(item.agent_id, item.agent_name ?? item.agent_id);
  return [...seen]
    .map(([id, name]) => ({ id, name }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Replaces one request of a list with its new state. */
export function replaceApproval(items: readonly Approval[], next: Approval): Approval[] {
  return items.map((item) => (item.approval_id === next.approval_id ? next : item));
}

const OWN_ERRORS = [
  'own_request',
  'already_signed',
  'version_conflict',
  'expired',
  'not_found',
  'tool_unavailable',
  'agent_unavailable',
  'execution_unavailable',
  'forbidden',
  'audit_unavailable',
] as const;
export type ApprovalErrorKey = `approvals.errors.${(typeof OWN_ERRORS)[number] | 'generic'}`;

/** Message key of a failed decision; the server's text is never shown raw. */
export function approvalErrorKey(error: unknown): ApprovalErrorKey {
  if (error instanceof ApiError) {
    const code = OWN_ERRORS.find((known) => known === error.code);
    if (code) return `approvals.errors.${code}`;
    if (error.status === 403) return 'approvals.errors.forbidden';
    if (error.status === 404) return 'approvals.errors.not_found';
    if (error.status === 409) return 'approvals.errors.version_conflict';
    if (error.status === 410) return 'approvals.errors.expired';
  }
  return 'approvals.errors.generic';
}

/** The request on screen is stale: read it again. */
export function isStale(error: unknown): boolean {
  return error instanceof ApiError && [404, 409, 410].includes(error.status);
}

// --- Policies ----------------------------------------------------------------------------

export interface PolicyForm {
  condition: Condition;
  /** As typed; validated before sending. */
  amount: string;
  count: string;
  environment: (typeof ENVIRONMENTS)[number];
  approvers: number;
  expiresHours: number;
}

export function formOf(rule: PolicyRule): PolicyForm {
  return {
    condition: rule.condition,
    amount: rule.amount_usd ?? '',
    count: rule.count != null ? String(rule.count) : '1',
    environment: rule.environment === 'staging' ? 'staging' : 'prod',
    approvers: rule.approvers,
    expiresHours: rule.expires_hours,
  };
}

const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;

/** The amount as the API takes it (decimal string), or null when it is not a valid amount. */
export function parseAmount(text: string): string | null {
  const value = text.trim().replace(',', '.');
  return AMOUNT_RE.test(value) && Number(value) > 0 ? value : null;
}

export function parseCount(text: string): number | null {
  const value = Number(text.trim());
  return /^\d{1,6}$/.test(text.trim()) && value >= 1 ? value : null;
}

/** The rule a form describes, or null when its threshold is not valid. */
export function ruleOf(form: PolicyForm): PolicyRule | null {
  const base = {
    condition: form.condition,
    approvers: form.approvers,
    expires_hours: form.expiresHours,
  } as PolicyRule;
  if (form.condition === 'amount') {
    const amount = parseAmount(form.amount);
    return amount === null ? null : { ...base, amount_usd: amount };
  }
  if (form.condition === 'count') {
    const count = parseCount(form.count);
    return count === null ? null : { ...base, count };
  }
  if (form.condition === 'environment') return { ...base, environment: form.environment };
  return base;
}

/** Same rule in everything an administrator can change. */
export function sameRule(a: PolicyRule, b: PolicyRule): boolean {
  const amount = (rule: PolicyRule) => (rule.amount_usd ? Number(rule.amount_usd) : null);
  return (
    a.condition === b.condition &&
    a.approvers === b.approvers &&
    a.expires_hours === b.expires_hours &&
    amount(a) === amount(b) &&
    (a.count ?? null) === (b.count ?? null) &&
    (a.environment ?? null) === (b.environment ?? null)
  );
}
