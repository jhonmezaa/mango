import type { OperationOutput } from '../api/operations';

// The agents a user can chat with: what GET /api/agents returns for them (published and retired
// agents they may use). Nothing here decides access; the API authorizes every turn.

export type Agent = OperationOutput<'getAgents'>['items'][number];

/** Same shape the API accepts (`mango_core.agents.AGENT_ID_PATTERN`). */
const AGENT_ID_RE = /^(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})$/;

/** An agent id taken from the URL or from storage, or null when it is not one. */
export function parseAgentId(value: unknown): string | null {
  return typeof value === 'string' && AGENT_ID_RE.test(value) ? value : null;
}

/** A retired agent keeps its history but takes no new turns. */
export const isChatable = (agent: Agent) => agent.status === 'published';

/** Where a new conversation with an agent starts. */
export function chatPath(agentId: string | null): string {
  return agentId ? `/?agent=${encodeURIComponent(agentId)}` : '/';
}

/** `<connector or pack id>.<tool>` references -> how many connectors or packs they come from. */
export function serverCount(tools: readonly string[]): number {
  return new Set(tools.map((ref) => ref.split('.', 1)[0])).size;
}

/**
 * The agent a new conversation opens with when the URL names none: the one of the most recent
 * conversation, else the first one the user can use.
 */
export function defaultAgentId(
  agents: readonly Agent[],
  lastAgentIds: readonly string[],
): string | null {
  const usable = agents.filter(isChatable);
  const ids = new Set(usable.map((agent) => agent.id));
  return lastAgentIds.find((id) => ids.has(id)) ?? usable[0]?.id ?? null;
}
