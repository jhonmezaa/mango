import type { Catalog, Pack, PackRequest, Server, Tool } from './model';

// Catalog fixtures in the generated contract, shared by the tests of this screen.

export const XSS = '<img src=x onerror=alert(1)>';
export const OTHER_ADMIN = 'otra.admin@example.com';
export const CHANGE_ID = 'a'.repeat(32);

export function tool(server: string, name: string, overrides: Partial<Tool> = {}): Tool {
  return {
    ref: `${server}.${name}`,
    name,
    description: '',
    access: 'read',
    audience: 'all',
    central_groups_only: false,
    enabled: true,
    ...overrides,
  };
}

export function request(overrides: Partial<PackRequest> = {}): PackRequest {
  return {
    change_id: CHANGE_ID,
    kind: 'enable',
    pack_version: '1.0.0-1',
    config: {},
    reason: null,
    requested_by: 'sub-other',
    requested_by_email: OTHER_ADMIN,
    created_at: new Date(Date.now() - 42 * 60_000).toISOString(),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    own: false,
    ...overrides,
  };
}

export function pack(overrides: Partial<Pack> = {}): Pack {
  return {
    status: 'available',
    version: '1.0.0-1',
    installed_version: null,
    lock_version: 0,
    params: [],
    update: null,
    pending: null,
    last_rejected: null,
    ...overrides,
  };
}

export function server(overrides: Partial<Server> & Pick<Server, 'id' | 'name'>): Server {
  return {
    kind: 'pack',
    description: '',
    provider: 'AWS Labs',
    data_tier: 'public',
    identity_mode: 'service',
    enabled: false,
    permissions: [],
    tools: [],
    agents: [],
    pack: pack(),
    ...overrides,
  };
}

export const REGION = {
  key: 'region',
  description: 'Región',
  allowed: ['us-east-1', 'eu-west-1'],
  default: 'us-east-1',
  value: null,
};

export const costExplorer = server({
  id: 'cost-explorer',
  kind: 'connector',
  name: 'AWS Cost Explorer',
  description: 'Gasto de las cuentas de AWS.',
  provider: 'Mango',
  data_tier: 'account_data',
  identity_mode: 'per_user',
  enabled: true,
  permissions: ['ce:GetCostAndUsage'],
  tools: [
    tool('cost-explorer', 'get_cost_and_usage', { description: 'Gasto real.' }),
    tool('cost-explorer', 'get_savings_plans_utilization', {
      audience: 'central',
      central_groups_only: true,
    }),
  ],
  agents: [{ id: 'finops', name: 'FinOps', category: 'Finanzas' }],
  pack: null,
});

export const pricing = server({
  id: 'aws-pricing',
  name: 'AWS Pricing',
  description: `Precios públicos de AWS. ${XSS}`,
  enabled: true,
  permissions: ['pricing:GetProducts'],
  tools: [tool('aws-pricing', 'get_products'), tool('aws-pricing', 'list_services')],
  agents: [{ id: 'k3fq7zr2m5xw6n4a', name: XSS, category: 'Finanzas' }],
  pack: pack({
    status: 'enabled',
    installed_version: '1.0.0-1',
    lock_version: 2,
    requested_by: 'sub-ana',
    requested_by_email: 'ana@example.com',
    requested_at: new Date(Date.now() - 86_400_000).toISOString(),
    approved_by: 'sub-other',
    approved_by_email: OTHER_ADMIN,
  }),
});

export const billing = server({
  id: 'aws-billing',
  name: 'AWS Billing',
  description: 'Facturas y créditos.',
  data_tier: 'account_data',
  identity_mode: 'central_only',
  permissions: ['billing:GetBillingData', 'ce:GetCostAndUsage'],
  tools: [
    tool('aws-billing', 'list_invoices', {
      audience: 'central',
      central_groups_only: true,
      enabled: false,
    }),
  ],
  pack: pack({
    status: 'pending',
    version: '0.9.3-1',
    lock_version: 1,
    params: [REGION],
    pending: request({
      pack_version: '0.9.3-1',
      config: { region: 'eu-west-1' },
      reason: `Conciliar facturas ${XSS}`,
    }),
  }),
});

export const documentation = server({
  id: 'aws-documentation',
  name: 'AWS Documentation',
  description: 'Documentación pública de AWS.',
  tools: [tool('aws-documentation', 'search_documentation', { enabled: false })],
  pack: pack({ version: '1.4.0-1', params: [REGION] }),
});

export const ec2 = server({
  id: 'ec2-operations',
  name: 'EC2 Operations',
  description: 'Instancias de EC2.',
  data_tier: 'write',
  identity_mode: 'central_only',
  enabled: true,
  permissions: ['ec2:DescribeInstances', 'ec2:StopInstances'],
  tools: [
    tool('ec2-operations', 'describe_instances'),
    tool('ec2-operations', 'stop_instances', { access: 'write' }),
    tool('ec2-operations', 'reboot_instances', { access: 'write', enabled: false }),
  ],
  pack: pack({
    status: 'enabled',
    version: '1.3.0-1',
    installed_version: '1.2.0-1',
    lock_version: 4,
    params: [{ ...REGION, value: 'us-east-1' }],
    update: {
      version: '1.3.0-1',
      added_tools: ['reboot_instances'],
      removed_tools: ['start_instances'],
      added_permissions: ['ec2:RebootInstances'],
      removed_permissions: [],
    },
    pending: request({
      kind: 'update',
      pack_version: '1.3.0-1',
      config: { region: 'us-east-1' },
    }),
    approved_by: 'sub-other',
    approved_by_email: OTHER_ADMIN,
  }),
});

export const health = server({
  id: 'aws-health',
  name: 'AWS Health',
  description: 'Eventos de salud.',
  enabled: true,
  permissions: ['health:DescribeEvents'],
  tools: [tool('aws-health', 'describe_events')],
  pack: pack({
    status: 'enabled',
    installed_version: '1.0.0-1',
    lock_version: 3,
    params: [{ ...REGION, value: 'us-east-1' }],
    pending: request({ kind: 'params', config: { region: 'eu-west-1' }, own: true }),
    approved_by: 'sub-other',
  }),
});

export const anomaly = server({
  id: 'cost-anomaly',
  name: 'Cost Anomaly Detection',
  description: 'Anomalías de gasto.',
  data_tier: 'account_data',
  tools: [tool('cost-anomaly', 'get_anomalies', { enabled: false })],
  pack: pack({
    status: 'error',
    lock_version: 2,
    failed_step: 'create_role',
    failure: 'AccessDenied',
    approved_by: 'sub-other',
  }),
});

export const support = server({
  id: 'aws-support',
  name: 'AWS Support',
  description: 'Casos de soporte.',
  data_tier: 'account_data',
  tools: [tool('aws-support', 'describe_cases', { enabled: false })],
  agents: [{ id: 'b3fq7zr2m5xw6n4a', name: 'Soporte', category: 'Operaciones' }],
  pack: pack({
    status: 'disabled',
    lock_version: 5,
    params: [REGION],
    disabled_by: 'sub-other',
    disabled_by_email: OTHER_ADMIN,
    disabled_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    last_rejected: {
      change_id: 'b'.repeat(32),
      kind: 'enable',
      decided_by: 'sub-other',
      decided_by_email: OTHER_ADMIN,
      decided_at: new Date().toISOString(),
      reason: XSS,
    },
  }),
});

export const logs = server({
  id: 'cloudwatch-logs',
  name: 'CloudWatch Logs Insights',
  description: 'Consultas de logs.',
  data_tier: 'account_data',
  tools: [tool('cloudwatch-logs', 'start_query', { enabled: false })],
  pack: pack({
    status: 'installing',
    lock_version: 2,
    status_at: new Date(Date.now() - 3 * 60_000).toISOString(),
  }),
});

export const ALL = [
  costExplorer,
  pricing,
  billing,
  documentation,
  ec2,
  health,
  anomaly,
  support,
  logs,
];

export function catalog(items: Server[] = ALL): Catalog {
  return { max_enabled_packs: 10, items };
}
