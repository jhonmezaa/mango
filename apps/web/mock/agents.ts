/**
 * Agents of the mock (Marketplace v1): the in-memory store shared by the Marketplace, Agent
 * Builder, review and Org Chart mocks, plus the agent detail the chat reads today.
 *
 * Records mirror the backend ones (`mango_core.agents.AgentDefinition`, `AgentMeta` and
 * `AgentVersion` of `mango_api.agents_store`). Ids are random, never incremental; release agents
 * keep their slug (D32). Some texts carry HTML to check that the screens render them as text.
 */
import { createHash, randomBytes } from 'node:crypto';

import { MOCK_USER } from './cognito.ts';
import { sendError, sendJson, type ApiHandler } from './http.ts';

export type MockVersionStatus =
  'draft' | 'in_review' | 'approved' | 'published' | 'failed' | 'superseded' | 'retired';

export interface MockAgentDefinition {
  name: string;
  description: string;
  category: string;
  icon: string;
  color: number;
  /** Agent id of the supervisor, or `platform` for the root of the organization chart (D30). */
  reports_to: string | null;
  role: string;
  model: string | null;
  allowed_models: string[];
  system_prompt: string;
  /** `<connector or pack id>.<tool name>`. */
  tools: string[];
  approval_tools: string[];
  limits: {
    max_tokens: number;
    max_iterations: number;
    timeout_seconds: number;
    max_tokens_per_call: number | null;
    temperature: number | null;
  };
  groups: string[];
  users: string[];
}

export interface MockAgentVersion {
  agent_id: string;
  number: number;
  status: MockVersionStatus;
  /** Optimistic lock of the draft. */
  revision: number;
  definition: MockAgentDefinition;
  /** Set when the version is sent to review; approval and publication go by this hash. */
  content_hash: string | null;
  base_version: number | null;
  created_by: string;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  failed_step: string | null;
  failure: string | null;
  published_at: string | null;
}

export interface MockAgent {
  agent_id: string;
  status: 'draft' | 'published' | 'retired';
  /** Optimistic lock of the agent (not a version number); `retire` adds one. */
  lock_version: number;
  latest_version: number;
  /** Draft, in review, approved or failed version, when there is one. */
  open_version: number | null;
  /** A retired agent keeps the version it had published, now `retired`. */
  published_version: number | null;
  created_by: string;
  created_at: string;
  retired_by: string | null;
  retired_at: string | null;
  retire_reason: string | null;
  versions: MockAgentVersion[];
}

export const MOCK_MODEL = 'mock.model-v1';
/** A second model of the mock catalog (`brains.ts`). */
export const MOCK_SECOND_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const ROOT_SUPERVISOR = 'platform';
/** Another admin of the mock installation: their versions can be reviewed by the mock user. */
export const OTHER_ADMIN = 'admin-2';
const OTHER_ADMIN_EMAIL = 'otra.admin@example.com';

/** Random public id: 16 lowercase base32 characters, like `mango_core.agents.new_agent_id`. */
export function newAgentId(): string {
  return Array.from(randomBytes(16), (byte) => 'abcdefghijklmnopqrstuvwxyz234567'[byte % 32]).join(
    '',
  );
}

/** SHA-256 of the definition as canonical JSON (sorted keys, no whitespace). */
export function contentHash(definition: MockAgentDefinition): string {
  const canonical = JSON.stringify(definition, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export const agents = new Map<string, MockAgent>();

export function versionOf(agent: MockAgent, number: number | null): MockAgentVersion | null {
  return agent.versions.find((version) => version.number === number) ?? null;
}

export function publishedVersion(agent: MockAgent): MockAgentVersion | null {
  return agent.status === 'published' ? versionOf(agent, agent.published_version) : null;
}

/** `Agent` of the contract (`AgentOut`): no prompt and no access lists. */
export function agentOut(agent: MockAgent, version: MockAgentVersion) {
  const { definition } = version;
  return {
    id: agent.agent_id,
    status: version.status,
    version: version.number,
    lock_version: agent.lock_version,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    icon: definition.icon,
    color: definition.color,
    role: definition.role,
    reports_to: definition.reports_to,
    model: definition.model ?? '',
    allowed_models: definition.allowed_models,
    tools: definition.tools,
    // The mock has no MCP packs: every tool of an agent is served.
    unavailable_tools: [] as string[],
    published_at: version.published_at,
    retired_at: agent.retired_at,
    retire_reason: agent.retire_reason,
    is_mine: agent.created_by === MOCK_USER,
    cleanup: cleanupOf(agent),
  };
}

/** Mock only: how long the "deprovisioner" takes to remove a retired agent's infrastructure. */
const CLEANUP_MS = 20_000;
/** Mock only: a retired agent whose removal failed, to see the notice of admins. */
export const CLEANUP_FAILED_REASON = 'limpieza fallida';

/** The mock user is an admin, so they are told how the removal goes (D48). */
function cleanupOf(agent: MockAgent): 'running' | 'done' | 'failed' | null {
  if (agent.status !== 'retired' || !agent.retired_at) return null;
  if (agent.retire_reason?.includes(CLEANUP_FAILED_REASON)) return 'failed';
  return Date.now() - Date.parse(agent.retired_at) < CLEANUP_MS ? 'running' : 'done';
}

const HOUR_MS = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();

function definition(
  overrides: Partial<MockAgentDefinition> & { name: string },
): MockAgentDefinition {
  return {
    description: '',
    category: '',
    icon: 'Bot',
    color: 0,
    reports_to: ROOT_SUPERVISOR,
    role: '',
    model: MOCK_MODEL,
    allowed_models: [MOCK_MODEL],
    system_prompt: '',
    tools: [],
    approval_tools: [],
    limits: {
      max_tokens: 4096,
      max_iterations: 8,
      timeout_seconds: 120,
      max_tokens_per_call: null,
      temperature: null,
    },
    groups: [],
    users: [],
    ...overrides,
  };
}

interface VersionSeed {
  status: MockVersionStatus;
  definition: MockAgentDefinition;
  created_by: string;
  hoursAgo: number;
  base_version?: number;
  approved_by?: string;
  rejected_by?: string;
  rejection_reason?: string;
  failed_step?: string;
}

function seedVersion(agentId: string, number: number, seed: VersionSeed): MockAgentVersion {
  const at = ago(seed.hoursAgo);
  const sent = seed.status !== 'draft';
  const approved = seed.approved_by ?? null;
  return {
    agent_id: agentId,
    number,
    status: seed.status,
    revision: 1,
    definition: seed.definition,
    content_hash: sent ? contentHash(seed.definition) : null,
    base_version: seed.base_version ?? null,
    created_by: seed.created_by,
    created_by_email:
      seed.created_by === MOCK_USER
        ? MOCK_USER
        : seed.created_by === OTHER_ADMIN
          ? OTHER_ADMIN_EMAIL
          : null,
    created_at: at,
    updated_at: at,
    submitted_by: sent ? seed.created_by : null,
    submitted_at: sent ? at : null,
    approved_by: approved,
    approved_at: approved ? at : null,
    rejected_by: seed.rejected_by ?? null,
    rejected_at: seed.rejected_by ? at : null,
    rejection_reason: seed.rejection_reason ?? null,
    failed_step: seed.failed_step ?? null,
    failure: seed.failed_step ? 'Simulated provisioning failure' : null,
    published_at: ['published', 'superseded', 'retired'].includes(seed.status) ? at : null,
  };
}

function seedAgent(
  agentId: string,
  seeds: VersionSeed[],
  retired?: { by: string; reason: string },
): MockAgent {
  const versions = seeds.map((seed, index) => seedVersion(agentId, index + 1, seed));
  const published =
    versions.findLast((version) => version.status === (retired ? 'retired' : 'published')) ?? null;
  const open =
    versions.findLast((version) =>
      ['draft', 'in_review', 'approved', 'failed'].includes(version.status),
    ) ?? null;
  const first = versions[0];
  if (!first) throw new Error('an agent needs at least one version');
  const agent: MockAgent = {
    agent_id: agentId,
    status: retired ? 'retired' : published ? 'published' : 'draft',
    lock_version: retired ? 2 : 1,
    latest_version: versions.length,
    open_version: open?.number ?? null,
    published_version: published?.number ?? null,
    created_by: first.created_by,
    created_at: first.created_at,
    retired_by: retired?.by ?? null,
    retired_at: retired ? ago(48) : null,
    retire_reason: retired?.reason ?? null,
    versions,
  };
  agents.set(agentId, agent);
  return agent;
}

const COST_TOOLS = [
  'cost-explorer.get_anomalies',
  'cost-explorer.get_cost_and_usage',
  'cost-explorer.get_cost_forecast',
  'cost-explorer.list_accounts_in_scope',
];

function seedAgents(): void {
  // Comes with the release, pre-approved by it (D34); keeps its slug.
  seedAgent('finops', [
    {
      status: 'published',
      created_by: 'release',
      approved_by: 'release@0.1.0',
      hoursAgo: 30 * 24,
      definition: definition({
        name: 'FinOps',
        description:
          'Analiza el gasto de AWS de tu organización o de tu área y propone optimizaciones.',
        category: 'Finanzas',
        icon: 'Money',
        color: 2,
        role: 'Analista FinOps',
        // Two allowed models, so the chat's model switcher has something to choose (D22).
        allowed_models: [MOCK_MODEL, MOCK_SECOND_MODEL],
        system_prompt: 'You are Mango FinOps.',
        tools: COST_TOOLS,
        limits: {
          max_tokens: 8000,
          max_iterations: 12,
          timeout_seconds: 300,
          max_tokens_per_call: 4000,
          temperature: 0.2,
        },
        groups: ['bu-finanzas', 'bu-retail', 'finops-central'],
      }),
    },
  ]);

  // Published, with a draft of the mock user on top of it ("editing a published agent").
  const savings = definition({
    name: 'Savings Plans',
    description: 'Revisa la cobertura de Savings Plans y sugiere compras.',
    category: 'Finanzas',
    icon: 'Zap',
    color: 4,
    reports_to: 'finops',
    role: 'Especialista en compromisos',
    system_prompt: 'You review Savings Plans coverage.\nAnswer in Spanish.',
    tools: [
      'aws-pricing.get_products',
      'cost-explorer.get_cost_and_usage',
      'cost-explorer.get_savings_plans_coverage',
    ],
    groups: ['finops-central'],
  });
  seedAgent('k3fq7zr2m5xw6n4a', [
    {
      status: 'superseded',
      created_by: OTHER_ADMIN,
      approved_by: MOCK_USER,
      hoursAgo: 20 * 24,
      definition: { ...savings, description: 'Revisa la cobertura de Savings Plans.' },
    },
    {
      status: 'published',
      created_by: OTHER_ADMIN,
      approved_by: MOCK_USER,
      hoursAgo: 6 * 24,
      base_version: 1,
      definition: savings,
    },
    {
      status: 'draft',
      created_by: MOCK_USER,
      hoursAgo: 3,
      base_version: 2,
      definition: {
        ...savings,
        system_prompt: `${savings.system_prompt}\nAlways state the period.`,
        tools: [...savings.tools, 'cost-explorer.get_cost_forecast'].sort(),
      },
    },
  ]);

  // New agent of another admin waiting for review: the mock user can approve or reject it.
  seedAgent('b6t2hd5yq7lc3vpe', [
    {
      status: 'in_review',
      created_by: OTHER_ADMIN,
      hoursAgo: 5,
      definition: definition({
        name: 'Anomalías <b>Retail</b>',
        description: 'Explica las anomalías de gasto del área. <script>alert(1)</script>',
        category: 'Finanzas',
        icon: 'Activity',
        color: 5,
        reports_to: 'finops',
        role: 'Analista de anomalías',
        system_prompt: 'You explain spend anomalies.\n<img src=x onerror=alert(1)>',
        tools: ['cost-explorer.get_anomalies', 'cost-explorer.list_accounts_in_scope'],
        groups: ['bu-retail'],
        // usuario4@empresa.com in the mock directory, and someone it no longer has.
        users: ['00000000-0000-4000-8000-000000000004', 'a1b2c3d4-0000-4000-8000-00000000abcd'],
      }),
    },
  ]);

  // Own version in review: the API refuses the creator's approval.
  seedAgent('w4nx2g7ajr5ue6ms', [
    {
      status: 'in_review',
      created_by: MOCK_USER,
      hoursAgo: 2,
      definition: definition({
        name: 'Pronósticos',
        description: 'Proyecta el gasto de fin de mes por área.',
        category: 'Finanzas',
        icon: 'Clock',
        color: 1,
        reports_to: 'finops',
        role: 'Analista de pronósticos',
        system_prompt: 'You forecast month-end spend.',
        tools: ['cost-explorer.get_cost_forecast'],
        groups: ['finops-central'],
      }),
    },
  ]);

  // Approved, but the publication failed: an admin can retry it.
  seedAgent('p2ys6ke4c7dq3hzo', [
    {
      status: 'failed',
      created_by: OTHER_ADMIN,
      approved_by: MOCK_USER,
      failed_step: 'create_harness',
      hoursAgo: 26,
      definition: definition({
        name: 'Etiquetado',
        description: 'Encuentra recursos sin etiquetas de costo.',
        category: 'Operación',
        icon: 'Search',
        color: 6,
        reports_to: ROOT_SUPERVISOR,
        role: 'Auditor de etiquetas',
        system_prompt: 'You find untagged spend.',
        tools: ['cost-explorer.get_cost_and_usage'],
        groups: ['finops-central'],
      }),
    },
  ]);

  // Rejected with a reason: back to draft for its creator.
  seedAgent('d7vm3a5txo2r6ifb', [
    {
      status: 'draft',
      created_by: MOCK_USER,
      rejected_by: OTHER_ADMIN,
      rejection_reason: 'Falta indicar a quién reporta y el rol.',
      hoursAgo: 50,
      definition: definition({
        name: 'Resumen semanal',
        description: 'Resume el gasto de la semana.',
        reports_to: null,
        system_prompt: 'You summarize weekly spend.',
        tools: ['cost-explorer.get_cost_and_usage'],
      }),
    },
  ]);

  // Retired: stays in the Marketplace history and cannot open conversations.
  seedAgent(
    'h5cu4n6sl2we7ygt',
    [
      {
        status: 'retired',
        created_by: OTHER_ADMIN,
        approved_by: MOCK_USER,
        hoursAgo: 60 * 24,
        definition: definition({
          name: 'Reportes mensuales',
          description: 'Generaba el reporte mensual de gasto.',
          category: 'Finanzas',
          icon: 'BookOpen',
          color: 3,
          reports_to: 'finops',
          role: 'Reportes',
          system_prompt: 'You write the monthly report.',
          tools: ['cost-explorer.get_cost_and_usage'],
          groups: ['finops-central'],
        }),
      },
    ],
    { by: OTHER_ADMIN, reason: 'Lo reemplaza FinOps. <i>Sin uso</i> desde agosto.' },
  );
}
seedAgents();

/** GET /agents/{id}: the published (or retired) version of an agent, as the chat reads it. */
export const handleAgents: ApiHandler = (req, res, path) => {
  const match = /^\/agents\/([a-z0-9-]{1,64})$/.exec(path);
  if (!match || req.method !== 'GET') return Promise.resolve(false);
  const agent = agents.get(match[1] ?? '');
  const version = agent ? versionOf(agent, agent.published_version) : null;
  if (!agent || !version) {
    // The mock user is an admin: the API answers 403 to whoever cannot use the agent.
    sendError(res, 404, 'not_found', 'Agent not found');
    return Promise.resolve(true);
  }
  sendJson(res, 200, agentOut(agent, version));
  return Promise.resolve(true);
};
