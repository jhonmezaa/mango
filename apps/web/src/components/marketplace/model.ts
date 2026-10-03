import type { OperationOutput } from '../../api/operations';

// Pure helpers of the Marketplace (design marketplace.jsx): what a filter shows and in what order.
// Everything here works on the agents the API returned; nothing decides access.

export type Agent = OperationOutput<'getAgents'>['items'][number];
export type MineItem = OperationOutput<'getMine'>['items'][number];
export type AgentBudget = OperationOutput<'getBudgets'>['agents'][number];

export type MarketTab = 'active' | 'archived';
export type Layout = 'cards' | 'list';
export type Sort = 'relevance' | 'name' | 'usage' | 'spend';
export const SORTS: readonly Sort[] = ['relevance', 'name', 'usage', 'spend'];

/** Root of the organization chart (`reports_to` of the agents without a supervisor agent). */
export const ROOT_SUPERVISOR = 'platform';
/** `definition.name` limit of the API. */
const MAX_NAME = 40;

/** The agent that comes with the release (design `fin-01`). */
export const RELEASE_AGENT_ID = 'finops';
/**
 * What the release agent can query (connectors/cost-explorer tools; texts in `agent.capabilities`).
 * A definition carries no capabilities, so no other agent shows any.
 */
export const RELEASE_AGENT_CAPABILITIES = [
  'costs',
  'areas',
  'forecast',
  'anomalies',
  'savingsPlans',
] as const;

export const isRetired = (agent: Agent) => agent.status === 'retired';

/**
 * Design: «Editar» and «Duplicar» are for admins and for whoever created the agent. Only what
 * the menu offers: the API authorizes every action (`EditAgent`, `CreateAgent`).
 */
export function canManageAgent(
  agent: Agent,
  me: { isAdmin: boolean; canCreate: boolean },
): boolean {
  return me.isAdmin || (me.canCreate && agent.is_mine);
}

/**
 * Design `mkShowBudget`: the month's spend is shown for agents that spent something, and always
 * for the release agent. Budgets only reach admins.
 */
export function shownBudget(
  agent: Agent,
  budgets: ReadonlyMap<string, AgentBudget>,
): AgentBudget | undefined {
  const budget = budgets.get(agent.id);
  if (!budget) return undefined;
  return Number(budget.spent_usd) > 0 || agent.id === RELEASE_AGENT_ID ? budget : undefined;
}

/** A removal of infrastructure still running: the page asks again until it settles. */
export const isCleaning = (agent: Agent) => agent.cleanup === 'running';

export function inTab(agents: readonly Agent[], tab: MarketTab): Agent[] {
  return agents.filter((agent) => isRetired(agent) === (tab === 'archived'));
}

/** Design `matchQ`: name, description and category (the API has no capabilities). */
export function matchesQuery(agent: Agent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [agent.name, agent.description, agent.category, agent.role]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export function categoriesOf(agents: readonly Agent[]): string[] {
  return [...new Set(agents.map((agent) => agent.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );
}

export function countByCategory(agents: readonly Agent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.category, (counts.get(agent.category) ?? 0) + 1);
  return counts;
}

const spentOf = (budgets: ReadonlyMap<string, AgentBudget>, agent: Agent) =>
  Number(budgets.get(agent.id)?.spent_usd ?? 0) || 0;

/**
 * Design `sorters`. "Relevancia" has no usage data behind it yet: it is the name. "Mayor gasto"
 * needs the budgets, which only admins receive; for everyone else it is the name too.
 */
export function sortAgents(
  agents: readonly Agent[],
  sort: Sort,
  budgets: ReadonlyMap<string, AgentBudget>,
): Agent[] {
  const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name, 'es');
  if (sort === 'spend') {
    return agents.toSorted((a, b) => spentOf(budgets, b) - spentOf(budgets, a) || byName(a, b));
  }
  return agents.toSorted(byName);
}

/** `<connector or pack id>.<tool name>` grouped by connector, in the order they first appear. */
export function toolsByServer(tools: readonly string[]): { server: string; tools: string[] }[] {
  const servers = new Map<string, string[]>();
  for (const ref of tools) {
    const dot = ref.indexOf('.');
    const server = dot > 0 ? ref.slice(0, dot) : ref;
    const names = servers.get(server) ?? [];
    names.push(dot > 0 ? ref.slice(dot + 1) : ref);
    servers.set(server, names);
  }
  return [...servers].map(([server, names]) => ({ server, tools: names }));
}

/** Design `clone`: "<name> (copia)", cut to the name limit of the API. */
export function copyName(name: string, suffix: string): string {
  return `${name.slice(0, MAX_NAME - suffix.length).trimEnd()}${suffix}`;
}

export type MineStatus = 'draft' | 'review' | 'rejected' | 'approved' | 'failed';

/** Design `REV_STATUS` of an own version: a rejected one is a draft again, with its reason. */
export function mineStatus(item: MineItem): MineStatus {
  if (item.status === 'in_review') return 'review';
  if (item.status === 'approved') return 'approved';
  if (item.status === 'failed') return 'failed';
  return item.rejected_at ? 'rejected' : 'draft';
}

/**
 * Where the Agent Builder (design view `admin`) opens. An agent is always opened on one of its
 * versions: `/admin/<id>` alone needs `UseAgent` to find the published one, which its creator
 * may not have.
 */
export const builderPath = {
  create: '/admin',
  version: (agentId: string, version: number) =>
    `/admin/${encodeURIComponent(agentId)}/${String(version)}`,
};

/** Names of the models of the catalog by identifier; empty for who cannot read the catalog. */
export type ModelNames = ReadonlyMap<string, string>;

export const NO_MODEL_NAMES: ModelNames = new Map();
