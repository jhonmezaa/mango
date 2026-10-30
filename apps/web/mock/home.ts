/**
 * Mock route of Inicio (D102): GET /home?period=…, with the rules of `mango_api.home` over the
 * other mocks. The mock user is an administrator, so the scope is the organization and the
 * budgets are the agents'. The day counters are a fixed, deterministic series for development
 * (the product reads them from the Budgets table). The response follows the generated contract.
 */
import { budgetsView } from './admin.ts';
import { approverRequests } from './approvals.ts';
import { sendError, sendJson, type ApiHandler } from './http.ts';
import { queue } from './knowledge.ts';

const DAY_MS = 86_400_000;
const PERIODS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '180d': 180 };
const MAX_BUDGETS = 4;

/** Spend and turns of a day `offset` days before today: a fixed curve, never random. */
function dayOf(offset: number, now: number) {
  const day = new Date(now - offset * DAY_MS).toISOString().slice(0, 10);
  const wave = 1 + 0.35 * Math.sin(offset / 3) + (offset % 7 === 0 ? 0.6 : 0);
  const trend = 1 + Math.max(0, 120 - offset) / 120;
  const turns = Math.round(18 * wave * trend);
  return { day, spent_usd: (turns * 0.0421).toFixed(6), turns };
}

function budgets() {
  const percent = (spent: string, limit: string) =>
    Number(limit) > 0 ? Number(spent) / Number(limit) : 0;
  return budgetsView()
    .agents.map((agent) => ({
      scope: 'agent' as const,
      id: agent.agent_id,
      name: agent.name,
      spent_usd: agent.spent_usd,
      limit_usd: agent.limit_usd,
    }))
    .sort((a, b) => percent(b.spent_usd, b.limit_usd) - percent(a.spent_usd, a.limit_usd))
    .slice(0, MAX_BUDGETS);
}

export const handleHome: ApiHandler = (req, res, path, url) => {
  if (path !== '/home' || req.method !== 'GET') return Promise.resolve(false);
  const period = url.searchParams.get('period') ?? '30d';
  const count = PERIODS[period];
  if (count === undefined) {
    sendError(res, 422, 'invalid_request', 'invalid fields: period');
    return Promise.resolve(true);
  }
  const now = Date.now();
  const days = Array.from({ length: count }, (_, i) => dayOf(count - 1 - i, now));
  const previous = Array.from({ length: count }, (_, i) => dayOf(2 * count - 1 - i, now));
  const mine = approverRequests().filter((item) => item.status === 'pending' && item.can_sign);
  const sources = queue().filter((source) => source.status === 'pending' && source.can_decide);
  sendJson(res, 200, {
    scope: 'org',
    area: null,
    period,
    counted_since: new Date(now - 200 * DAY_MS).toISOString().slice(0, 10),
    days,
    previous,
    approvals: mine.length + sources.length,
    budgets_scope: 'agents',
    budgets: budgets(),
  });
  return Promise.resolve(true);
};
