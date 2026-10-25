/**
 * Mock route of Gobernanza (D89): GET /governance, with the rules of `mango_api.governance` over
 * the other mocks. The mock user is an administrator, so every section comes. The response follows
 * the generated contract (packages/ts/api-client).
 */
import { budgetsView, livePending } from './admin.ts';
import { approverRequests, currentPolicy } from './approvals.ts';
import { auditEvents } from './audit.ts';
import { sendJson, type ApiHandler } from './http.ts';
import { queue } from './knowledge.ts';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const AUDIT_CAP = 5000;
const RECENT = 7;
const WARN = 80;
const EVENTS = [
  'approval.request',
  'approval.approve',
  'approval.reject',
  'approval.expire',
  'approval.policy.',
  'settings.budget.updated',
  'budget.exceeded',
  'settings.bu_mapping.',
  'agent.retired',
  'agent.version.approved',
  'agent.version.rejected',
  'settings.groups.',
  'directory.group_add',
  'directory.group_remove',
  'directory.area_change',
  'directory.member_propose',
  'directory.member_approve',
  'directory.member_reject',
  'directory.member_withdraw',
  'mcp.pack.request.',
];
const APPROVED = new Set(['approved', 'executing', 'executed', 'failed']);

const isGovernance = (event: string) =>
  EVENTS.some((name) => (name.endsWith('.') ? event.startsWith(name) : event === name));
const isRead = (event: { event: string; detail: Record<string, unknown> }) =>
  event.event === 'directory.list' ||
  event.event === 'session.renewed' ||
  (event.event === 'policy.decision' &&
    event.detail.allowed === true &&
    event.detail.read_only === true);

function approvals(now: number) {
  const requests = approverRequests();
  const pending = requests.filter((item) => item.status === 'pending');
  const mine = pending.filter((item) => item.can_sign);
  const inWeek = (at: string | null) => at !== null && Date.parse(at) >= now - WEEK_MS;
  const decided = requests.filter((item) => inWeek(item.decided_at));
  const sources = queue().filter((source) => source.status === 'pending');
  const byTool = new Map<string, { pending: number; total: number }>();
  for (const item of requests) {
    if (item.status !== 'pending' && !inWeek(item.created_at)) continue;
    const line = byTool.get(item.tool) ?? { pending: 0, total: 0 };
    line.total += 1;
    if (item.status === 'pending') line.pending += 1;
    byTool.set(item.tool, line);
  }
  const first = pending.map((item) => item.expires_at).sort()[0] ?? null;
  return {
    pending: pending.length + sources.length,
    mine: mine.length + sources.filter((source) => source.can_decide).length,
    mine_soon: mine.filter((item) => Date.parse(item.expires_at) - now < 3_600_000).length,
    next_expires_at: first,
    approved_7d: decided.filter((item) => APPROVED.has(item.status)).length,
    rejected_7d: decided.filter((item) => item.status === 'rejected').length,
    policies: [...byTool.entries()]
      .sort(([a, x], [b, y]) => y.pending - x.pending || y.total - x.total || a.localeCompare(b))
      .map(([tool, line]) => ({
        tool,
        server_name: 'AWS Budgets',
        policy: { ...currentPolicy() },
        ...line,
      })),
    capped: false,
  };
}

function budgets() {
  const view = budgetsView();
  const percent = (spent: string, limit: string) =>
    Number(limit) > 0 ? (Number(spent) / Number(limit)) * 100 : Number(spent) > 0 ? 100 : 0;
  const lines = [
    ...view.agents.map((agent) => ({
      scope: 'agent' as const,
      id: agent.agent_id,
      name: agent.name,
      spent_usd: agent.spent_usd,
      limit_usd: agent.limit_usd,
    })),
    ...view.users.map((user) => ({
      scope: 'user' as const,
      id: user.user_id,
      name: user.email,
      spent_usd: user.spent_usd,
      limit_usd: user.limit_usd,
    })),
  ]
    .map((line) => ({ line, pct: percent(line.spent_usd, line.limit_usd) }))
    .filter(({ pct }) => pct >= WARN)
    .sort((a, b) => b.pct - a.pct);
  return {
    period: view.period,
    over_warn: lines.map(({ line, pct }) => ({ ...line, exhausted: pct >= 100 })),
  };
}

function audit(now: number) {
  const events = auditEvents();
  const day = events.filter((event) => Date.parse(event.ts) >= now - DAY_MS);
  const counted = day.slice(0, AUDIT_CAP).filter((event) => !isRead(event)).length;
  const recent = events
    .filter(
      (event) =>
        Date.parse(event.ts) >= now - WEEK_MS &&
        isGovernance(event.event) &&
        !isRead(event) &&
        [undefined, 'applied'].includes(event.detail.outcome as string | undefined),
    )
    .slice(0, RECENT);
  return { events_24h: counted, capped: day.length > AUDIT_CAP, recent };
}

export const handleGovernance: ApiHandler = (req, res, path) => {
  if (path !== '/governance' || req.method !== 'GET') return Promise.resolve(false);
  const now = Date.now();
  sendJson(res, 200, {
    approvals: approvals(now),
    budgets: budgets(),
    areas: { pending: livePending().length },
    audit: audit(now),
  });
  return Promise.resolve(true);
};
