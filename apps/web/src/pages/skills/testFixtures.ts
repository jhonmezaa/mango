import type { Server } from '../mcpCatalog/model';
import type { Skill, SkillChange, SkillDetail, SkillsList } from './model';

/** Text that would be markup if it were ever rendered as HTML. */
export const XSS = '<img src=x onerror=alert(1)>';
export const CHANGE_ID = 'a'.repeat(32);
export const OTHER_CHANGE_ID = 'b'.repeat(32);

export function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'revision-de-costos',
    name: 'Revisión de costos',
    category: 'FinOps',
    description: 'Resume el gasto del período',
    version: 3,
    servers: [
      {
        id: 'cost-explorer',
        name: 'AWS Cost Explorer',
        enabled: true,
        data_tier: 'account_data',
        tools: 4,
        writes: false,
      },
    ],
    data_tier: 'account_data',
    writes: false,
    available: true,
    agents: 2,
    outdated_agents: 1,
    runs_30d: 1240,
    owner: 'u-3',
    owner_email: 'usuario3@example.com',
    updated_by: 'u-2',
    updated_by_email: 'usuario2@example.com',
    updated_at: '2026-10-20T10:00:00Z',
    pending: null,
    ...overrides,
  };
}

export function change(overrides: Partial<SkillChange> = {}): SkillChange {
  return {
    change_id: CHANGE_ID,
    skill_id: 'revision-de-costos',
    version: 4,
    status: 'pending',
    name: 'Revisión de costos',
    category: 'FinOps',
    description: 'Resume el gasto del período',
    instructions: 'Paso 1\nPaso 2 nuevo\nPaso 3',
    outputs: ['tabla'],
    servers: ['cost-explorer'],
    variables: [],
    reason: 'Mejora el paso 2',
    proposed_by: 'u-3',
    proposed_by_email: 'usuario3@example.com',
    created_at: '2026-10-25T08:00:00Z',
    expires_at: '2026-10-28T08:00:00Z',
    duplicate_of: null,
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    note: null,
    own: false,
    ...overrides,
  };
}

export function list(items: Skill[] = [skill()], overrides: Partial<SkillsList> = {}): SkillsList {
  return {
    items,
    changes: [],
    categories: ['FinOps', 'DevOps', 'ERP', 'Productivity', 'Security', 'Data'],
    max_per_agent: 10,
    can_approve: true,
    ...overrides,
  };
}

export function detail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    skill: skill(),
    instructions: 'Paso 1\nPaso 2 con {{período}}\nPaso 3',
    outputs: ['tabla'],
    variables: ['período'],
    agents_using: [
      { id: 'agent-a', name: 'FinOps', agent_version: 4, skill_version: 3 },
      { id: 'agent-b', name: 'Savings Plans', agent_version: 2, skill_version: 2 },
    ],
    versions: [1, 2, 3].map((version) => ({
      version,
      proposed_by: 'u-3',
      proposed_by_email: 'usuario3@example.com',
      approved_by: 'u-1',
      approved_by_email: 'usuario1@example.com',
      approved_at: '2026-10-20T10:00:00Z',
      markdown_sha256: 'f'.repeat(64),
    })),
    changes: [],
    ...overrides,
  };
}

export function server(overrides: Partial<Server> = {}): Server {
  return {
    agents: [],
    data_tier: 'account_data',
    description: '',
    enabled: true,
    id: 'cost-explorer',
    identity_mode: 'user',
    kind: 'connector',
    name: 'AWS Cost Explorer',
    pack: null,
    permissions: [],
    provider: 'aws',
    tools: [],
    ...overrides,
  };
}
