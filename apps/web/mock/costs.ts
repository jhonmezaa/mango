/**
 * Mock route of Costos (D105–D107): GET /costs?month=…, with the shape of `mango_api.costs`. The
 * mock user is an administrator. The day counters are a fixed, deterministic series for
 * development (the product reads them from the Budgets table): the organization's counts from
 * months ago, the agents' from the 17th of two months ago, and the model's and origin's (D106)
 * from eight days ago, so the view shows «Sin desglose». The response follows the generated
 * contract.
 */
import { agents, MOCK_SECOND_MODEL, publishedVersion } from './agents.ts';
import { sendError, sendJson, type ApiHandler } from './http.ts';

const DAY_MS = 86_400_000;
const LIMIT = 30;
const ORIGINS = ['chat', 'task', 'playground', 'eval'] as const;
/** Share of each origin, and of the titles of new conversations (no agent, model or origin). */
const ORIGIN_SHARE = { chat: 0.7, task: 0.22, playground: 0.05, eval: 0.03 } as const;
const TITLES = 0.006;

const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

function monthDays(year: number, month: number): string[] {
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => iso(Date.UTC(year, month, i + 1)));
}

/** Spend of a day: a fixed curve, lower on weekends, never random. */
function spentOn(day: string): number {
  const time = Date.parse(`${day}T00:00:00Z`);
  const weekday = new Date(time).getUTCDay();
  const wave = 1 + 0.25 * Math.sin(time / DAY_MS / 3);
  return (weekday === 0 || weekday === 6 ? 0.4 : 1) * wave * 6.4;
}

const money = (value: number) => value.toFixed(2);

export const handleCosts: ApiHandler = (req, res, path, url) => {
  if (path !== '/costs' || req.method !== 'GET') return Promise.resolve(false);
  const now = new Date();
  const asked = url.searchParams.get('month');
  const current = iso(now.getTime()).slice(0, 7);
  if (asked !== null && asked !== current) {
    sendError(res, 422, 'invalid_month', 'that month is not kept');
    return Promise.resolve(true);
  }
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const all = monthDays(year, month);
  const today = now.getUTCDate();
  const days = all.slice(0, today);
  const previousDays = monthDays(month === 0 ? year - 1 : year, (month + 11) % 12);
  const agentSince = iso(Date.UTC(year, month - 2, 17));
  const splitSince = iso(Date.UTC(year, month, Math.min(today, Math.max(2, today - 8))));
  const sum = (list: string[], from = '') =>
    list.filter((day) => day >= from).reduce((total, day) => total + spentOn(day), 0);
  const spent = sum(days);
  const previous = sum(previousDays);
  const elapsed = days.length;
  const projection = (value: number) =>
    elapsed < 5 ? null : money((value / elapsed) * all.length);

  const published = [...agents.values()]
    .map((agent) => ({ agent, version: publishedVersion(agent) }))
    .filter((item) => item.version !== null)
    .slice(0, 5);
  const weights = published.map((_, i) => 1 / (i + 1.4));
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  const agentTotal = spent * (1 - TITLES);
  const rows = published.map(({ agent, version }, i) => {
    const share = (weights[i] ?? 0) / weightSum;
    const value = agentTotal * share;
    const before = previous * (1 - TITLES) * share * (0.75 + ((i * 37) % 50) / 100);
    return {
      id: agent.agent_id,
      spent_usd: money(value),
      turns: Math.round(value / 0.0421),
      previous_usd: money(before),
      projected_usd: projection(value),
      name: version?.definition.name ?? null,
      category: version?.definition.category || null,
      model: version?.definition.model ?? null,
      budget: { limit_usd: money(LIMIT), spent_usd: money(value * 1.02) },
    };
  });
  const rowSum = rows.reduce((total, row) => total + Number(row.spent_usd), 0);
  const rowPrevious = rows.reduce((total, row) => total + Number(row.previous_usd), 0);

  const splitSpent = sum(days, splitSince) * (1 - TITLES);
  const before = spent - sum(days, splitSince);
  const models = [...new Set(rows.map((row) => row.model).filter(Boolean)), MOCK_SECOND_MODEL]
    .slice(0, 3)
    .map((id, i, list) => {
      const value = (splitSpent * (list.length - i)) / ((list.length * (list.length + 1)) / 2);
      return {
        id: String(id),
        spent_usd: money(value),
        turns: Math.round(value / 0.0421),
        previous_usd: '0.00',
        projected_usd: null,
      };
    });
  const sources = ORIGINS.map((id) => {
    const value = splitSpent * ORIGIN_SHARE[id];
    return {
      id,
      spent_usd: money(value),
      turns: Math.round(value / 0.0421),
      previous_usd: '0.00',
      projected_usd: null,
    };
  });
  const split = (rest: number) => ({
    counted_since: splitSince,
    unattributed_usd: money(rest),
    previous_unattributed_usd: money(previous),
    before_since_usd: money(before),
    previous_before_since_usd: money(previous),
  });
  const turnsOf = (day: string) => Math.round(spentOn(day) / 0.0421);
  sendJson(res, 200, {
    month: current,
    previous_month: previousDays[0]?.slice(0, 7) ?? current,
    days_in_month: all.length,
    elapsed_days: elapsed,
    closed: false,
    counted_since: iso(Date.UTC(year, month - 6, 3)),
    days: days.map((day) => ({ day, spent_usd: spentOn(day).toFixed(6), turns: turnsOf(day) })),
    previous_days: previousDays.map((day) => ({
      day,
      spent_usd: spentOn(day).toFixed(6),
      turns: turnsOf(day),
    })),
    spent_usd: money(spent),
    turns: Math.round(spent / 0.0421),
    previous_usd: money(previous),
    previous_turns: Math.round(previous / 0.0421),
    projected_usd: projection(spent),
    agents: {
      counted_since: agentSince,
      unattributed_usd: money(Math.max(0, spent - rowSum)),
      previous_unattributed_usd: money(Math.max(0, previous - rowPrevious)),
      before_since_usd: '0.00',
      previous_before_since_usd: '0.00',
      rows,
    },
    models: {
      ...split(spent - models.reduce((total, row) => total + Number(row.spent_usd), 0)),
      rows: models,
    },
    sources: {
      ...split(spent - sources.reduce((total, row) => total + Number(row.spent_usd), 0)),
      rows: sources,
    },
  });
  return Promise.resolve(true);
};
