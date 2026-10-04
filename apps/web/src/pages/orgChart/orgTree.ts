import type { OrgNode, OrgOut } from '@mango/api-client/types';

/**
 * A node of the organization chart: an agent, the root of the installation (not an agent), or
 * the «Supervisor no visible» node that gathers the agents whose supervisor the caller cannot see.
 */
export interface TreeNode {
  id: string;
  /** Published version of the agent; null for the root and the hidden supervisor. */
  version: number | null;
  name: string;
  role: string;
  /** Agent texts for the panel; empty for the root and the hidden supervisor. */
  description: string;
  category: string;
  icon: string;
  /** Whether who is signed in may use the agent (a hint from the API; true for non-agents). */
  canUse: boolean;
  /** Groups that use an agent the caller cannot use; empty otherwise. */
  groups: readonly string[];
  isRoot: boolean;
  /** Design `ghost`: stands for supervisors that are retired or not visible to the caller. */
  ghost: boolean;
  depth: number;
  kids: TreeNode[];
}

/** Id of the «Supervisor no visible» node; it cannot be an agent id (`AGENT_ID_PATTERN`). */
export const HIDDEN_SUPERVISOR_ID = '__hidden';

interface NodeLabel {
  name: string;
  role: string;
}

export interface OrgTree {
  root: TreeNode;
  /** Every node, the root first, in display order. */
  all: TreeNode[];
  byId: ReadonlyMap<string, TreeNode>;
}

/**
 * Builds the «Reporta a» tree from GET /api/agents/org (design other-views.jsx `OrgChart`).
 * An agent whose supervisor is missing hangs from «Supervisor no visible», like the design's
 * `map[m] || hidden`: the API sends `reports_to: null` when the supervisor is retired or not
 * visible to the caller, so the line to the root would show a reporting relation that is not
 * real. That node only exists when it has agents. The response is untrusted input, so repeated
 * ids are dropped and a cycle is cut by hanging one of its agents from the root instead of looping.
 */
export function buildTree(org: OrgOut, labels: { root: NodeLabel; hidden: NodeLabel }): OrgTree {
  const base = {
    version: null,
    description: '',
    category: '',
    depth: 0,
    canUse: true,
    groups: [],
  };
  const root: TreeNode = {
    ...base,
    ...labels.root,
    id: org.root,
    icon: 'Shield',
    isRoot: true,
    ghost: false,
    kids: [],
  };
  const hidden: TreeNode = {
    ...base,
    ...labels.hidden,
    id: HIDDEN_SUPERVISOR_ID,
    icon: 'Lock',
    isRoot: false,
    ghost: true,
    kids: [],
  };
  const byId = new Map<string, TreeNode>([[root.id, root]]);
  const agents: OrgNode[] = [];
  for (const agent of org.nodes) {
    if (byId.has(agent.id) || agent.id === HIDDEN_SUPERVISOR_ID) continue;
    byId.set(agent.id, {
      id: agent.id,
      version: agent.version,
      name: agent.name,
      // Design: `a.role || a.cat`.
      role: agent.role || agent.category,
      description: agent.description,
      category: agent.category,
      icon: agent.icon,
      canUse: agent.can_use,
      groups: agent.groups,
      isRoot: false,
      ghost: false,
      depth: 0,
      kids: [],
    });
    agents.push(agent);
  }
  for (const agent of agents) {
    const node = byId.get(agent.id);
    const supervisor = agent.reports_to === null ? undefined : byId.get(agent.reports_to);
    if (!node) continue;
    // A supervisor that is itself (bad data) is a cycle: it is cut below, from the root.
    if (supervisor === node) root.kids.push(node);
    else (supervisor ?? hidden).kids.push(node);
  }
  if (hidden.kids.length > 0) {
    root.kids.push(hidden);
    byId.set(hidden.id, hidden);
  }

  const all: TreeNode[] = [];
  const seen = new Set<string>();
  const visit = (node: TreeNode, depth: number) => {
    seen.add(node.id);
    node.depth = depth;
    all.push(node);
    for (const kid of node.kids) visit(kid, depth + 1);
  };
  visit(root, 0);
  // What the root does not reach is a cycle of supervisors.
  for (const agent of agents) {
    const node = byId.get(agent.id);
    if (!node || seen.has(node.id)) continue;
    const supervisor = agent.reports_to === null ? undefined : byId.get(agent.reports_to);
    if (supervisor) supervisor.kids = supervisor.kids.filter((kid) => kid !== node);
    root.kids.push(node);
    visit(node, 1);
  }
  return { root, all, byId };
}

/** Nodes below a node, at any depth (design `count`). */
export function countBelow(node: TreeNode): number {
  return node.kids.reduce((sum, kid) => sum + 1 + countBelow(kid), 0);
}

/**
 * Agents that supervise at least one agent. As in the design
 * (`n.kids.length && n.id !== 'platform' && !n.ghost`), neither the root nor «Supervisor no
 * visible» counts: they are not agents.
 */
export function countSupervisors(tree: OrgTree): number {
  return tree.all.filter((node) => !node.isRoot && !node.ghost && node.kids.length > 0).length;
}

/** Design: «Colapsar» folds the first level under the root. */
export function firstLevelSupervisors(tree: OrgTree): Set<string> {
  return new Set(
    tree.all.filter((node) => node.depth === 1 && node.kids.length > 0).map((node) => node.id),
  );
}

/** Design: `(n.name + ' ' + n.role).toLowerCase().includes(q.toLowerCase())`. */
export function matches(node: TreeNode, query: string): boolean {
  return query !== '' && `${node.name} ${node.role}`.toLowerCase().includes(query.toLowerCase());
}
