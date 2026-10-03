import { describe, expect, it } from 'vitest';

import {
  canManageAgent,
  isCleaning,
  RELEASE_AGENT_ID,
  shownBudget,
  builderPath,
  categoriesOf,
  copyName,
  countByCategory,
  inTab,
  matchesQuery,
  mineStatus,
  sortAgents,
  toolsByServer,
  type Agent,
  type AgentBudget,
  type MineItem,
} from './model';

function agent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    status: 'published',
    version: 1,
    lock_version: null,
    name: overrides.id,
    description: '',
    category: 'Finanzas',
    icon: 'Bot',
    color: 0,
    role: '',
    reports_to: 'platform',
    model: 'model-a',
    allowed_models: ['model-a'],
    tools: [],
    unavailable_tools: [],
    published_at: '2026-09-01T00:00:00Z',
    retired_at: null,
    retire_reason: null,
    is_mine: false,
    cleanup: null,
    ...overrides,
  };
}

function mine(overrides: Partial<MineItem>): MineItem {
  return {
    agent_id: 'k3fq7zr2m5xw6n4a',
    version: 1,
    status: 'draft',
    revision: 1,
    base_version: null,
    name: 'Borrador',
    description: '',
    category: '',
    icon: 'Bot',
    color: 0,
    created_at: '2026-09-30T10:00:00Z',
    updated_at: '2026-09-30T10:00:00Z',
    submitted_at: null,
    rejected_at: null,
    rejection_reason: null,
    failed_step: null,
    ...overrides,
  };
}

const AGENTS = [
  agent({ id: 'finops', name: 'FinOps', description: 'Analiza el gasto de AWS' }),
  agent({ id: 'b', name: 'Etiquetado', category: 'Operación', role: 'Auditor de etiquetas' }),
  agent({ id: 'c', name: 'Reportes', status: 'retired' }),
];

describe('marketplace model', () => {
  it('splits active and retired agents by tab', () => {
    expect(inTab(AGENTS, 'active').map((item) => item.id)).toEqual(['finops', 'b']);
    expect(inTab(AGENTS, 'archived').map((item) => item.id)).toEqual(['c']);
  });

  it('searches name, description, category and role, ignoring case and outer spaces', () => {
    const matches = (query: string) =>
      AGENTS.filter((item) => matchesQuery(item, query)).map((item) => item.id);
    expect(matches('  ')).toEqual(['finops', 'b', 'c']);
    expect(matches('GASTO')).toEqual(['finops']);
    expect(matches('operación')).toEqual(['b']);
    expect(matches(' auditor ')).toEqual(['b']);
    expect(matches('nada')).toEqual([]);
  });

  it('lists and counts categories, leaving out the empty one', () => {
    const list = [...AGENTS, agent({ id: 'd', category: '' })];
    expect(categoriesOf(list)).toEqual(['Finanzas', 'Operación']);
    expect(countByCategory(list).get('Finanzas')).toBe(2);
  });

  it('sorts by name, and by spend when there are budgets', () => {
    const budgets = new Map<string, AgentBudget>([
      ['b', { agent_id: 'b', name: null, limit_usd: '100.00', spent_usd: '90.00' }],
      ['finops', { agent_id: 'finops', name: 'FinOps', limit_usd: '100.00', spent_usd: '5.00' }],
    ]);
    expect(sortAgents(AGENTS, 'name', budgets).map((item) => item.id)).toEqual([
      'b',
      'finops',
      'c',
    ]);
    expect(sortAgents(AGENTS, 'spend', budgets).map((item) => item.id)).toEqual([
      'b',
      'finops',
      'c',
    ]);
    expect(sortAgents(AGENTS, 'spend', new Map()).map((item) => item.id)).toEqual([
      'b',
      'finops',
      'c',
    ]);
    // The input is never reordered in place.
    expect(AGENTS.map((item) => item.id)).toEqual(['finops', 'b', 'c']);
  });

  it('groups tool references by connector', () => {
    expect(
      toolsByServer([
        'cost-explorer.get_cost_and_usage',
        'aws-pricing.get_price',
        'cost-explorer.x',
      ]),
    ).toEqual([
      { server: 'cost-explorer', tools: ['get_cost_and_usage', 'x'] },
      { server: 'aws-pricing', tools: ['get_price'] },
    ]);
    expect(toolsByServer(['sin-punto'])).toEqual([{ server: 'sin-punto', tools: ['sin-punto'] }]);
  });

  it('names a copy within the 40 characters of the API', () => {
    expect(copyName('FinOps', ' (copia)')).toBe('FinOps (copia)');
    const long = copyName('Un nombre de agente que ya ocupa cuarenta', ' (copia)');
    expect(long).toHaveLength(40);
    expect(long.endsWith(' (copia)')).toBe(true);
  });

  it('maps an own version to the status of the design', () => {
    expect(mineStatus(mine({}))).toBe('draft');
    expect(mineStatus(mine({ rejected_at: '2026-09-30T11:00:00Z' }))).toBe('rejected');
    expect(mineStatus(mine({ status: 'in_review' }))).toBe('review');
    expect(mineStatus(mine({ status: 'approved' }))).toBe('approved');
    expect(mineStatus(mine({ status: 'failed' }))).toBe('failed');
  });

  it('builds Agent Builder paths with encoded ids', () => {
    expect(builderPath.create).toBe('/admin');
    expect(builderPath.version('finops', 2)).toBe('/admin/finops/2');
    expect(builderPath.version('a/b', 3)).toBe('/admin/a%2Fb/3');
  });
});

describe('what the design shows per agent', () => {
  const mine = agent({ id: 'mine', is_mine: true });
  const theirs = agent({ id: 'theirs' });

  it('lets admins manage every agent, and creators only the ones they created', () => {
    expect(canManageAgent(theirs, { isAdmin: true, canCreate: false })).toBe(true);
    expect(canManageAgent(mine, { isAdmin: false, canCreate: true })).toBe(true);
    expect(canManageAgent(theirs, { isAdmin: false, canCreate: true })).toBe(false);
    // Without the creator role the flag alone offers nothing.
    expect(canManageAgent(mine, { isAdmin: false, canCreate: false })).toBe(false);
  });

  it('shows the spend of agents that spent something, and always of the release agent', () => {
    const budget = (agent_id: string, spent_usd: string): AgentBudget => ({
      agent_id,
      name: null,
      limit_usd: '100.00',
      spent_usd,
    });
    const budgets = new Map([
      ['mine', budget('mine', '0.00')],
      ['theirs', budget('theirs', '0.01')],
      [RELEASE_AGENT_ID, budget(RELEASE_AGENT_ID, '0.00')],
    ]);
    expect(shownBudget(mine, budgets)).toBeUndefined();
    expect(shownBudget(theirs, budgets)?.spent_usd).toBe('0.01');
    expect(shownBudget(agent({ id: RELEASE_AGENT_ID }), budgets)?.spent_usd).toBe('0.00');
    // Not an admin: no budgets at all.
    expect(shownBudget(theirs, new Map())).toBeUndefined();
  });

  it('knows when an infrastructure removal is still running', () => {
    expect(isCleaning(agent({ id: 'a', status: 'retired', cleanup: 'running' }))).toBe(true);
    expect(isCleaning(agent({ id: 'a', status: 'retired', cleanup: 'failed' }))).toBe(false);
    expect(isCleaning(theirs)).toBe(false);
  });
});
