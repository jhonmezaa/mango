import type { BuilderContext, Definition, OrgNode, Quotas, Version } from './model';

// Fixtures of the Agent Builder tests: a small installation and version records of the contract.

export const context: BuilderContext = {
  models: [
    {
      id: 'model.main',
      name: 'Modelo Principal',
      provider: 'Anthropic',
      supports_tools: true,
      context_tokens: 200000,
      input_usd: '3',
      output_usd: '15',
    },
    {
      id: 'model.fast',
      name: 'Modelo Rápido',
      provider: 'Anthropic',
      supports_tools: true,
      context_tokens: 200000,
      input_usd: '0.8',
      output_usd: '4',
    },
    {
      id: 'model.text',
      name: 'Modelo Texto',
      provider: 'Amazon',
      supports_tools: false,
      context_tokens: null,
      input_usd: '0.2',
      output_usd: '0.6',
    },
  ],
  catalog: [
    {
      id: 'cost-explorer',
      kind: 'connector',
      name: 'AWS Cost Explorer',
      description: 'Gasto de AWS.',
      provider: 'Mango',
      data_tier: 'account_data',
      identity_mode: 'per_user',
      enabled: true,
      permissions: ['ce:GetCostAndUsage'],
      agents: [],
      tools: [
        {
          ref: 'cost-explorer.per_user',
          name: 'per_user',
          description: 'Gasto que cada persona puede ver. <b>texto</b>',
          access: 'read',
          audience: 'all',
          central_groups_only: false,
          enabled: true,
        },
        {
          ref: 'cost-explorer.org_wide',
          name: 'org_wide',
          description: 'Gasto de toda la organización.',
          access: 'read',
          audience: 'central',
          central_groups_only: true,
          requires_service: 'Compute Optimizer',
          enabled: true,
        },
      ],
    },
    {
      id: 'ops',
      kind: 'pack',
      name: 'Operaciones',
      description: 'Detiene instancias.',
      provider: 'AWS Labs',
      data_tier: 'write',
      identity_mode: 'central_only',
      enabled: true,
      permissions: ['ec2:StopInstances'],
      agents: [],
      tools: [
        {
          ref: 'ops.stop',
          name: 'stop',
          description: 'Detener instancias.',
          access: 'write',
          audience: 'all',
          central_groups_only: false,
          enabled: true,
        },
      ],
    },
    {
      id: 'billing',
      kind: 'pack',
      name: 'Billing',
      description: 'Facturas.',
      provider: 'AWS Labs',
      data_tier: 'account_data',
      identity_mode: 'central_only',
      enabled: false,
      permissions: [],
      agents: [],
      tools: [
        {
          ref: 'billing.invoices',
          name: 'invoices',
          description: 'Facturas del periodo.',
          access: 'read',
          audience: 'central',
          central_groups_only: true,
          enabled: true,
        },
      ],
    },
  ],
  groups: [
    { id: 'finops-central', type: 'central', area: null, description: 'FinOps central' },
    { id: 'bu-retail', type: 'area', area: 'retail', description: 'Líderes de Retail' },
    { id: 'todos', type: 'general', area: null, description: 'Toda la organización' },
  ],
};

const node = (id: string, name: string, reportsTo: string): OrgNode => ({
  id,
  version: 1,
  name,
  role: `Rol de ${name}`,
  description: '',
  category: 'FinOps',
  icon: 'Bot',
  color: 0,
  reports_to: reportsTo,
  can_use: true,
  can_edit: true,
  groups: [],
});

/** platform → finops → savings → forecast; platform → tagging. */
export const orgNodes: OrgNode[] = [
  node('finops', 'FinOps', 'platform'),
  node('savings', 'Savings Plans', 'finops'),
  node('forecast', 'Pronósticos', 'savings'),
  node('tagging', 'Etiquetado', 'platform'),
];

export const quotas: Quotas = {
  drafts: 2,
  max_drafts: 20,
  submissions_today: 1,
  max_submissions_per_day: 5,
};

export function definition(overrides: Partial<Definition> = {}): Definition {
  return {
    name: 'Analista de costos',
    description: 'Analiza el gasto.',
    category: 'FinOps',
    icon: 'Money',
    color: 1,
    reports_to: 'platform',
    role: 'Analista',
    model: 'model.main',
    allowed_models: ['model.main'],
    system_prompt: 'Analiza el gasto y responde en español.',
    tools: ['cost-explorer.per_user'],
    approval_tools: [],
    limits: {
      max_tokens: 4096,
      max_iterations: 8,
      timeout_seconds: 120,
      max_tokens_per_call: null,
      temperature: null,
    },
    groups: ['finops-central'],
    users: [],
    ...overrides,
  };
}

export const AGENT_ID = 'k3fq7zr2m5xw6n4a';

export function version(overrides: Partial<Version> = {}): Version {
  return {
    agent_id: AGENT_ID,
    version: 1,
    status: 'draft',
    revision: 1,
    content_hash: null,
    base_version: null,
    created_by: 'user-1',
    created_by_email: 'ana.perez@example.com',
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-01T10:00:00Z',
    submitted_by: null,
    submitted_at: null,
    approved_by: null,
    approved_by_email: null,
    approved_at: null,
    rejected_by: null,
    rejected_by_email: null,
    rejected_at: null,
    rejection_reason: null,
    failed_step: null,
    failure: null,
    published_at: null,
    is_author: true,
    agent: {
      status: 'draft',
      lock_version: 1,
      published_version: null,
      open_version: 1,
      created_by: 'user-1',
    },
    definition: definition(),
    base: null,
    diff: { is_new: true, fields: [], sets: [], prompt: null, changes: 0 },
    violations: [],
    ...overrides,
  };
}
