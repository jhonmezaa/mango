import type { OrgNode, OrgOut } from '@mango/api-client/types';
import { describe, expect, it } from 'vitest';

import {
  HIDDEN_SUPERVISOR_ID,
  buildTree,
  countBelow,
  countSupervisors,
  firstLevelSupervisors,
  matches,
  type TreeNode,
} from './orgTree';

const ROOT = { name: 'Platform Admin', role: 'Raíz · no es un agente' };
const HIDDEN = { name: 'Supervisor no visible', role: 'No tienes acceso a su supervisor' };
const LABELS = { root: ROOT, hidden: HIDDEN };

function agent(id: string, reportsTo: string | null, overrides: Partial<OrgNode> = {}): OrgNode {
  return {
    id,
    version: 1,
    name: id.toUpperCase(),
    role: `${id} role`,
    description: '',
    category: 'Finanzas',
    icon: 'Bot',
    color: 0,
    reports_to: reportsTo,
    can_use: true,
    groups: [],
    ...overrides,
  };
}

const org = (...nodes: OrgNode[]): OrgOut => ({ root: 'platform', nodes });
const ids = (nodes: TreeNode[]) => nodes.map((node) => node.id);

function node(tree: ReturnType<typeof buildTree>, id: string): TreeNode {
  const found = tree.byId.get(id);
  if (!found) throw new Error(`missing node ${id}`);
  return found;
}

describe('buildTree', () => {
  it('hangs each agent from its supervisor, under the root «Platform Admin»', () => {
    const tree = buildTree(
      org(agent('a', 'platform'), agent('b', 'a'), agent('c', 'a'), agent('d', 'c')),
      LABELS,
    );
    expect(tree.root).toMatchObject({
      id: 'platform',
      ...ROOT,
      icon: 'Shield',
      isRoot: true,
      ghost: false,
    });
    // Nothing is hidden: there is no «Supervisor no visible» node.
    expect(tree.byId.has(HIDDEN_SUPERVISOR_ID)).toBe(false);
    expect(ids(tree.root.kids)).toEqual(['a']);
    expect(ids(node(tree, 'a').kids)).toEqual(['b', 'c']);
    expect(ids(node(tree, 'c').kids)).toEqual(['d']);
    expect(ids(tree.all)).toEqual(['platform', 'a', 'b', 'c', 'd']);
    expect(tree.all.map((item) => item.depth)).toEqual([0, 1, 2, 2, 3]);
  });

  it('uses the root id the API sends', () => {
    const tree = buildTree({ root: 'top', nodes: [agent('a', 'top')] }, LABELS);
    expect(tree.root.id).toBe('top');
    expect(ids(tree.root.kids)).toEqual(['a']);
  });

  it('hangs the agents without a visible supervisor from «Supervisor no visible»', () => {
    // `null`: the supervisor is retired or the caller may not see it (D38). Unknown: bad data.
    const tree = buildTree(
      org(agent('a', null), agent('b', 'gone'), agent('c', 'platform'), agent('d', 'a')),
      LABELS,
    );
    expect(ids(tree.root.kids)).toEqual(['c', HIDDEN_SUPERVISOR_ID]);
    const hidden = node(tree, HIDDEN_SUPERVISOR_ID);
    expect(hidden).toMatchObject({ ...HIDDEN, icon: 'Lock', ghost: true, isRoot: false, depth: 1 });
    expect(hidden.version).toBeNull();
    expect(ids(hidden.kids)).toEqual(['a', 'b']);
    expect(ids(node(tree, 'a').kids)).toEqual(['d']);
    expect(node(tree, 'd').depth).toBe(3);
    // Design (closing round): the node is not an agent, so it is not a supervisor («a» is the
    // only one); it still folds with the first level.
    expect(countSupervisors(tree)).toBe(1);
    expect([...firstLevelSupervisors(tree)]).toEqual([HIDDEN_SUPERVISOR_ID]);
  });

  it('keeps the texts of each agent for the panel', () => {
    const tree = buildTree(
      org(agent('a', 'platform', { description: 'Hace <b>cosas</b>', category: 'Ventas' })),
      LABELS,
    );
    expect(node(tree, 'a')).toMatchObject({ description: 'Hace <b>cosas</b>', category: 'Ventas' });
    expect(tree.root).toMatchObject({ description: '', category: '' });
  });

  it('drops an agent that claims the id of the hidden supervisor', () => {
    const tree = buildTree(
      org(agent(HIDDEN_SUPERVISOR_ID, 'platform'), agent('a', HIDDEN_SUPERVISOR_ID)),
      LABELS,
    );
    expect(ids(tree.all)).toEqual(['platform', HIDDEN_SUPERVISOR_ID, 'a']);
    expect(node(tree, HIDDEN_SUPERVISOR_ID).ghost).toBe(true);
  });

  it('falls back to the category when the agent has no role', () => {
    const tree = buildTree(org(agent('a', 'platform', { role: '' })), LABELS);
    expect(node(tree, 'a').role).toBe('Finanzas');
  });

  it('cuts supervisor cycles instead of losing the agents or looping', () => {
    const tree = buildTree(
      org(agent('a', 'b'), agent('b', 'a'), agent('self', 'self'), agent('c', 'platform')),
      LABELS,
    );
    expect(ids(tree.all).sort()).toEqual(['a', 'b', 'c', 'platform', 'self']);
    expect(ids(tree.root.kids).sort()).toEqual(['a', 'c', 'self']);
    expect(ids(node(tree, 'a').kids)).toEqual(['b']);
    expect(node(tree, 'b').kids).toEqual([]);
    expect(countBelow(tree.root)).toBe(4);
  });

  it('ignores repeated ids and an agent that claims the id of the root', () => {
    const tree = buildTree(
      org(
        agent('a', 'platform'),
        agent('a', 'platform', { name: 'Other' }),
        agent('platform', 'a'),
      ),
      LABELS,
    );
    expect(ids(tree.all)).toEqual(['platform', 'a']);
    expect(node(tree, 'a').name).toBe('A');
    expect(tree.root.name).toBe('Platform Admin');
  });
});

describe('tree helpers', () => {
  const tree = buildTree(
    org(agent('a', 'platform'), agent('b', 'a'), agent('c', 'b'), agent('d', 'platform')),
    LABELS,
  );

  it('counts the agents below a node and the supervisors', () => {
    expect(countBelow(tree.root)).toBe(4);
    expect(countBelow(node(tree, 'a'))).toBe(2);
    expect(countBelow(node(tree, 'd'))).toBe(0);
    // The root is not an agent.
    expect(countSupervisors(tree)).toBe(2);
  });

  it('folds the first level that has subordinates', () => {
    expect([...firstLevelSupervisors(tree)]).toEqual(['a']);
  });

  it('matches by name or role, ignoring case; an empty query matches nothing', () => {
    expect(matches(node(tree, 'a'), 'A ROLE')).toBe(true);
    expect(matches(node(tree, 'a'), 'a')).toBe(true);
    expect(matches(node(tree, 'a'), 'zzz')).toBe(false);
    expect(matches(node(tree, 'a'), '')).toBe(false);
  });
});
