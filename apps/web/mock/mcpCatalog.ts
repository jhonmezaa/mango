/**
 * Mock routes of the MCP catalog (docs/specs/poc-api-contract.md, "Catálogo de MCP"): GET
 * /mcp/catalog and the requests to enable, change or disable a pack. In-memory state in the
 * generated contract (packages/ts/api-client). It has one pack in each status of the API, and
 * strings with HTML to check they render as text.
 *
 * Differences with the API, on purpose: any pack can be requested (the API only installs public
 * packs with read tools today) and the "provisioner" finishes by itself a few seconds after an
 * approval. The mock has one user, so a request of their own can never be approved here.
 */
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import { OTHER_ADMIN, agents, publishedVersion } from './agents.ts';
import { auditedWrite } from './audit.ts';
import { MOCK_USER } from './cognito.ts';
import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const REQUEST_TTL_MS = 7 * 24 * HOUR_MS;
/** How long the mock "provisioner" takes to install or remove a pack. */
const PROVISION_MS = 4000;
const REASON_MAX_LENGTH = 500;
const MAX_ENABLED_PACKS = 10;
const OTHER_ADMIN_EMAIL = 'otra.admin@example.com';

type PackStatus =
  'available' | 'pending' | 'installing' | 'enabled' | 'error' | 'disabling' | 'disabled';
type ChangeKind = 'enable' | 'params' | 'update';

interface MockTool {
  name: string;
  description: string;
  access: 'read' | 'write';
  audience: 'all' | 'central';
  /** AWS service the customer turns on in the payer account for the tool to answer. */
  requires_service?: string;
}

interface MockParam {
  key: string;
  description: string | null;
  allowed: string[];
  default: string;
}

interface MockRequest {
  change_id: string;
  kind: ChangeKind;
  pack_version: string;
  config: Record<string, string>;
  reason: string | null;
  requested_by: string;
  requested_by_email: string | null;
  created_at: string;
  expires_at: string;
}

interface MockUpdate {
  version: string;
  added_tools: string[];
  removed_tools: string[];
  added_permissions: string[];
  removed_permissions: string[];
}

interface MockPack {
  status: PackStatus;
  /** Version of the release. */
  version: string;
  /** Version agents use now (the provisioner's pointer), or null when nothing is installed. */
  installed_version: string | null;
  lock_version: number;
  params: MockParam[];
  /** Parameters in use; null before the first installation. */
  config: Record<string, string> | null;
  /** What moving from the installed version to the release's changes; null when up to date. */
  update: MockUpdate | null;
  pending: MockRequest | null;
  last_rejected: {
    change_id: string;
    kind: ChangeKind;
    decided_by: string;
    decided_by_email: string | null;
    decided_at: string;
    reason: string | null;
  } | null;
  status_at: string | null;
  failed_step: string | null;
  failure: string | null;
  requested_by: string | null;
  requested_by_email: string | null;
  requested_at: string | null;
  approved_by: string | null;
  approved_by_email: string | null;
  approved_at: string | null;
  disabled_by: string | null;
  disabled_by_email: string | null;
  disabled_at: string | null;
  disable_reason: string | null;
  /** Mock only: when the "provisioner" finishes and what it leaves. */
  settle: { at: number; config: Record<string, string> | null } | null;
}

interface MockServer {
  id: string;
  kind: 'connector' | 'pack';
  name: string;
  description: string;
  provider: string;
  data_tier: 'public' | 'account_data' | 'write';
  identity_mode: string;
  permissions: string[];
  tools: MockTool[];
  pack: MockPack | null;
}

const tool = (
  name: string,
  description = '',
  access: MockTool['access'] = 'read',
  audience: MockTool['audience'] = 'all',
): MockTool => ({ name, description, access, audience });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const REGION: MockParam = {
  key: 'region',
  description: 'Región',
  allowed: ['us-east-1', 'us-west-2', 'eu-west-1', 'sa-east-1'],
  default: 'us-east-1',
};

function pack(overrides: Partial<MockPack> & Pick<MockPack, 'status' | 'version'>): MockPack {
  return {
    installed_version: null,
    lock_version: 0,
    params: [],
    config: null,
    update: null,
    pending: null,
    last_rejected: null,
    status_at: null,
    failed_step: null,
    failure: null,
    requested_by: null,
    requested_by_email: null,
    requested_at: null,
    approved_by: null,
    approved_by_email: null,
    approved_at: null,
    disabled_by: null,
    disabled_by_email: null,
    disabled_at: null,
    disable_reason: null,
    settle: null,
    ...overrides,
  };
}

function request(
  kind: ChangeKind,
  packVersion: string,
  by: 'me' | 'other',
  createdMsAgo: number,
  config: Record<string, string>,
  reason: string | null,
): MockRequest {
  const created = Date.now() - createdMsAgo;
  return {
    change_id: randomBytes(16).toString('hex'),
    kind,
    pack_version: packVersion,
    config,
    reason,
    requested_by: by === 'me' ? MOCK_USER : OTHER_ADMIN,
    requested_by_email: by === 'me' ? MOCK_USER : OTHER_ADMIN_EMAIL,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + REQUEST_TTL_MS).toISOString(),
  };
}

/** Who asked for and who approved an installed pack. */
const installedBy = (requestedMsAgo: number) => ({
  requested_by: MOCK_USER,
  requested_by_email: MOCK_USER,
  requested_at: ago(requestedMsAgo),
  approved_by: OTHER_ADMIN,
  approved_by_email: OTHER_ADMIN_EMAIL,
  approved_at: ago(requestedMsAgo - HOUR_MS),
  status_at: ago(requestedMsAgo - HOUR_MS),
});

/**
 * `cost-explorer` is the release connector (connectors/cost-explorer/manifest.json). The tools
 * of a pack have no description: its signed manifest only carries name and access.
 */
const servers: MockServer[] = [
  {
    id: 'cost-explorer',
    kind: 'connector',
    name: 'AWS Cost Explorer',
    description:
      'Gasto, pronóstico, anomalías y Savings Plans de las cuentas de AWS que el usuario puede ver.',
    provider: 'Mango',
    data_tier: 'account_data',
    identity_mode: 'per_user',
    permissions: [
      'ce:GetAnomalies',
      'ce:GetCostAndUsage',
      'ce:GetCostForecast',
      'ce:GetSavingsPlansCoverage',
      'ce:GetSavingsPlansPurchaseRecommendation',
      'ce:GetSavingsPlansUtilization',
    ],
    tools: [
      tool('list_accounts_in_scope', 'Cuentas de AWS que el usuario puede analizar.'),
      tool('get_cost_and_usage', 'Gasto real por servicio, cuenta, región o tag.'),
      tool('get_cost_forecast', 'Pronóstico de gasto.'),
      tool('get_anomalies', 'Anomalías de gasto y su causa raíz.'),
      tool('get_savings_plans_coverage', 'Cobertura mensual de Savings Plans.'),
      tool(
        'get_savings_plans_utilization',
        'Uso y ahorro neto de Savings Plans de toda la organización.',
        'read',
        'central',
      ),
      tool(
        'get_savings_plans_recommendation',
        'Recomendación de compra de Savings Plans de toda la organización.',
        'read',
        'central',
      ),
    ],
    pack: null,
  },
  {
    id: 'aws-pricing',
    kind: 'pack',
    name: 'AWS Pricing',
    description: 'Precios públicos de servicios de AWS por región y configuración.',
    provider: 'AWS Labs',
    data_tier: 'public',
    identity_mode: 'service',
    permissions: ['pricing:DescribeServices', 'pricing:GetAttributeValues', 'pricing:GetProducts'],
    tools: [tool('get_products'), tool('list_services'), tool('get_attribute_values')],
    pack: pack({
      status: 'enabled',
      version: '1.1.1-1',
      installed_version: '1.1.1-1',
      lock_version: 2,
      ...installedBy(200 * HOUR_MS),
    }),
  },
  {
    id: 'ec2-operations',
    kind: 'pack',
    name: 'EC2 Operations',
    description: 'Consultar instancias y detenerlas o iniciarlas con aprobación.',
    provider: 'AWS Labs',
    data_tier: 'write',
    identity_mode: 'central_only',
    permissions: ['ec2:DescribeInstances', 'ec2:StartInstances', 'ec2:StopInstances'],
    tools: [
      tool('describe_instances', '', 'read', 'central'),
      tool('stop_instances', '', 'write', 'central'),
      tool('start_instances', '', 'write', 'central'),
      // Only in the release's version: nobody can use it until the update is approved.
      tool('reboot_instances', '', 'write', 'central'),
    ],
    pack: pack({
      status: 'enabled',
      version: '1.3.0-1',
      installed_version: '1.2.0-1',
      lock_version: 4,
      params: [REGION],
      config: { region: 'us-east-1' },
      update: {
        version: '1.3.0-1',
        added_tools: ['reboot_instances'],
        removed_tools: [],
        added_permissions: ['ec2:RebootInstances'],
        removed_permissions: [],
      },
      pending: request('update', '1.3.0-1', 'other', 3 * HOUR_MS, { region: 'us-east-1' }, null),
      ...installedBy(600 * HOUR_MS),
    }),
  },
  {
    id: 'aws-health',
    kind: 'pack',
    name: 'AWS Health',
    description: 'Eventos de salud de los servicios de AWS por región.',
    provider: 'AWS Labs',
    data_tier: 'public',
    identity_mode: 'service',
    permissions: ['health:DescribeEventDetails', 'health:DescribeEvents'],
    tools: [tool('describe_events'), tool('describe_event_details')],
    pack: pack({
      status: 'enabled',
      version: '0.6.2-1',
      installed_version: '0.6.2-1',
      lock_version: 3,
      params: [REGION],
      config: { region: 'us-east-1' },
      pending: request('params', '0.6.2-1', 'other', 50 * MINUTE_MS, { region: 'eu-west-1' }, null),
      ...installedBy(90 * HOUR_MS),
    }),
  },
  {
    id: 'aws-billing',
    kind: 'pack',
    name: 'AWS Billing',
    description: 'Facturas, créditos y utilización de Savings Plans de la organización.',
    provider: 'AWS Labs',
    data_tier: 'account_data',
    identity_mode: 'central_only',
    permissions: [
      'billing:GetBillingData',
      'invoicing:ListInvoiceSummaries',
      'savingsplans:DescribeSavingsPlans',
    ],
    tools: [
      tool('list_invoices', '', 'read', 'central'),
      tool('get_credits', '', 'read', 'central'),
      tool('get_savings_plans_utilization', '', 'read', 'central'),
      {
        ...tool('compute-optimizer', '', 'read', 'central'),
        requires_service: 'Compute Optimizer',
      },
      {
        ...tool('cost-optimization', '', 'read', 'central'),
        requires_service: 'Cost Optimization Hub',
      },
    ],
    pack: pack({
      status: 'pending',
      version: '0.9.3-1',
      lock_version: 1,
      params: [REGION],
      pending: request(
        'enable',
        '0.9.3-1',
        'other',
        42 * MINUTE_MS,
        { region: 'us-east-1' },
        'FinOps central necesita conciliar facturas <b>sin salir</b> de Mango.',
      ),
    }),
  },
  {
    id: 'aws-documentation',
    kind: 'pack',
    name: 'AWS Documentation',
    description: 'Busca y lee la documentación pública de AWS.',
    provider: 'AWS Labs',
    data_tier: 'public',
    identity_mode: 'service',
    permissions: [],
    tools: [tool('search_documentation'), tool('read_documentation')],
    pack: pack({ status: 'available', version: '1.4.0-1' }),
  },
  {
    id: 'cloudwatch-logs',
    kind: 'pack',
    name: 'CloudWatch Logs Insights',
    description: 'Consultas de Logs Insights sobre grupos de logs de la organización.',
    provider: 'AWS Labs',
    data_tier: 'account_data',
    identity_mode: 'central_only',
    permissions: ['logs:DescribeLogGroups', 'logs:GetQueryResults', 'logs:StartQuery'],
    tools: [
      tool('start_query', '', 'read', 'central'),
      tool('get_query_results', '', 'read', 'central'),
    ],
    pack: pack({
      // Stays installing: the mock only finishes what was approved in this session.
      status: 'installing',
      version: '1.0.1-1',
      lock_version: 2,
      params: [REGION],
      ...installedBy(2 * HOUR_MS),
      status_at: ago(3 * MINUTE_MS),
    }),
  },
  {
    id: 'cost-anomaly',
    kind: 'pack',
    name: 'Cost Anomaly Detection',
    description: 'Anomalías de gasto detectadas por AWS y su causa raíz.',
    provider: 'AWS Labs',
    data_tier: 'account_data',
    identity_mode: 'central_only',
    permissions: ['ce:GetAnomalies', 'ce:GetAnomalyMonitors'],
    tools: [
      tool('get_anomalies', '', 'read', 'central'),
      tool('get_monitors', '', 'read', 'central'),
    ],
    pack: pack({
      status: 'error',
      version: '0.4.0-1',
      lock_version: 2,
      params: [REGION],
      ...installedBy(6 * HOUR_MS),
      failed_step: 'create_role',
      failure: 'AccessDenied',
    }),
  },
  {
    id: 'aws-support',
    kind: 'pack',
    name: 'AWS Support',
    description: 'Casos de soporte y recomendaciones de Trusted Advisor.',
    provider: 'AWS Labs',
    data_tier: 'account_data',
    identity_mode: 'central_only',
    permissions: ['support:DescribeCases', 'support:DescribeTrustedAdvisorChecks'],
    tools: [
      tool('describe_cases', '', 'read', 'central'),
      tool('trusted_advisor_checks', '', 'read', 'central'),
    ],
    pack: pack({
      status: 'disabled',
      version: '1.0.0-1',
      lock_version: 5,
      params: [REGION],
      ...installedBy(900 * HOUR_MS),
      disabled_by: OTHER_ADMIN,
      disabled_by_email: OTHER_ADMIN_EMAIL,
      disabled_at: ago(66 * HOUR_MS),
      disable_reason: 'Nadie lo usaba <img src=x onerror=alert(1)>',
      last_rejected: {
        change_id: randomBytes(16).toString('hex'),
        kind: 'enable',
        decided_by: OTHER_ADMIN,
        decided_by_email: OTHER_ADMIN_EMAIL,
        decided_at: ago(20 * HOUR_MS),
        reason: 'Primero definan quién atiende los casos.',
      },
    }),
  },
];

/** Applies what the mock "provisioner" finished since the last read. */
function settle(): void {
  const now = Date.now();
  for (const server of servers) {
    const item = server.pack;
    if (!item?.settle || item.settle.at > now) continue;
    const { config } = item.settle;
    item.settle = null;
    item.status_at = new Date(now).toISOString();
    if (item.status === 'disabling') {
      item.status = 'disabled';
      item.installed_version = null;
      item.config = null;
    } else {
      item.status = 'enabled';
      item.installed_version = item.version;
      item.config = config ?? item.config ?? defaults(item);
      item.update = null;
    }
  }
}

function defaults(item: MockPack): Record<string, string> {
  return Object.fromEntries(item.params.map((param) => [param.key, param.default]));
}

/** The tools agents can use now: the ones the installed version serves. */
function served(server: MockServer, name: string): boolean {
  const item = server.pack;
  if (!item) return true;
  if (item.installed_version === null) return false;
  return !(item.update?.added_tools.includes(name) ?? false);
}

/** What the Agent Builder's rules need to know about a tool (`<server>.<tool>`). */
export function catalogTool(
  ref: string,
): { enabled: boolean; write: boolean; centralOnly: boolean } | null {
  settle();
  const dot = ref.indexOf('.');
  const server = servers.find((item) => item.id === ref.slice(0, dot));
  const found = server?.tools.find((item) => item.name === ref.slice(dot + 1));
  if (!server || !found) return null;
  return {
    enabled: served(server, found.name),
    write: found.access === 'write',
    // Same rule as the backend (D35): data the server does not filter per user.
    centralOnly: server.data_tier !== 'public' && found.audience === 'central',
  };
}

/** Published agents with tools of the server: who is affected when it is disabled. */
function agentsUsing(serverId: string) {
  const prefix = `${serverId}.`;
  return [...agents.values()]
    .flatMap((agent) => {
      const version = publishedVersion(agent);
      if (!version?.definition.tools.some((ref) => ref.startsWith(prefix))) return [];
      const { definition } = version;
      return [{ id: agent.agent_id, name: definition.name, category: definition.category }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function packOut(item: MockPack) {
  const { config, pending } = item;
  return {
    status: item.status,
    version: item.version,
    installed_version: item.installed_version,
    lock_version: item.lock_version,
    update: item.update,
    last_rejected: item.last_rejected,
    status_at: item.status_at,
    failed_step: item.failed_step,
    failure: item.failure,
    requested_by: item.requested_by,
    requested_by_email: item.requested_by_email,
    requested_at: item.requested_at,
    approved_by: item.approved_by,
    approved_by_email: item.approved_by_email,
    approved_at: item.approved_at,
    disabled_by: item.disabled_by,
    disabled_by_email: item.disabled_by_email,
    disabled_at: item.disabled_at,
    disable_reason: item.disable_reason,
    params: item.params.map((param) => ({
      ...param,
      value: item.installed_version === null ? null : (config?.[param.key] ?? param.default),
    })),
    pending: pending ? { ...pending, own: pending.requested_by === MOCK_USER } : null,
  };
}

/** GET /api/mcp/catalog, as an administrator sees it. */
export function catalogView() {
  settle();
  return {
    max_enabled_packs: MAX_ENABLED_PACKS,
    items: servers.map((server) => ({
      id: server.id,
      kind: server.kind,
      name: server.name,
      description: server.description,
      provider: server.provider,
      data_tier: server.data_tier,
      identity_mode: server.identity_mode,
      enabled: server.pack ? server.pack.installed_version !== null : true,
      permissions: server.permissions,
      tools: server.tools.map((item) => ({
        ...item,
        requires_service: item.requires_service ?? null,
        ref: `${server.id}.${item.name}`,
        central_groups_only: server.data_tier !== 'public' && item.audience === 'central',
        enabled: served(server, item.name),
      })),
      agents: agentsUsing(server.id),
      pack: server.pack ? packOut(server.pack) : null,
    })),
  };
}

// --- Writes -------------------------------------------------------------------------------------

const PACK_ROUTE =
  /^\/mcp\/([a-z0-9][a-z0-9-]{0,23})(?:\/(enablements|params|update|retry)(?:\/([0-9a-f]{32})\/(approve|reject|withdraw))?)?$/;

/** Fields of the body of each request route (extra="forbid"). */
const BODY_KEYS = new Map<string, readonly string[]>([
  ['enablements', ['version', 'config', 'reason']],
  ['params', ['version', 'config']],
  ['update', ['version', 'config']],
  ['retry', ['version']],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON body with exactly the allowed keys (extra="forbid"), or null. */
async function body(
  req: Parameters<ApiHandler>[0],
  allowed: readonly string[],
): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return Object.keys(parsed).every((key) => allowed.includes(key)) ? parsed : null;
}

function invalid(res: ServerResponse): true {
  sendError(res, 422, 'invalid_request', 'invalid fields: ?');
  return true;
}

function conflict(res: ServerResponse, code: string): true {
  sendError(res, 409, code, code);
  return true;
}

function reasonOf(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length >= 1 && text.length <= REASON_MAX_LENGTH ? text : undefined;
}

/** Keys of the manifest with values of its list; what is not sent takes `base`. */
function configOf(
  item: MockPack,
  value: unknown,
  base: Record<string, string>,
): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out = { ...base };
  for (const [key, chosen] of Object.entries(value)) {
    const param = item.params.find((candidate) => candidate.key === key);
    if (!param || typeof chosen !== 'string' || !param.allowed.includes(chosen)) return null;
    out[key] = chosen;
  }
  return out;
}

function propose(
  server: MockServer,
  item: MockPack,
  kind: ChangeKind,
  config: Record<string, string>,
  reason: string | null,
): void {
  const proposed = request(kind, item.version, 'me', 0, config, reason);
  auditedWrite(
    'mcp.pack.request.proposed',
    { pack: server.id, change_id: proposed.change_id, kind, pack_version: item.version, config },
    () => {
      item.pending = proposed;
      if (kind === 'enable') item.status = 'pending';
      item.lock_version += 1;
    },
  );
}

function startInstall(item: MockPack, config: Record<string, string> | null): void {
  item.status = 'installing';
  item.status_at = new Date().toISOString();
  item.failed_step = null;
  item.failure = null;
  item.settle = { at: Date.now() + PROVISION_MS, config };
}

export const handleMcpCatalog: ApiHandler = async (req, res, path) => {
  const { method } = req;
  if (path === '/mcp/catalog') {
    if (method !== 'GET') return false;
    sendJson(res, 200, catalogView());
    return true;
  }
  const match = PACK_ROUTE.exec(path);
  if (!match) return false;
  const [, packId, route, changeId, decision] = match;
  settle();
  const server = servers.find((candidate) => candidate.id === packId);
  const item = server?.pack ?? null;

  if (route === undefined) {
    if (method !== 'DELETE') return false;
    const input = await body(req, ['version', 'reason']);
    const reason = reasonOf(input?.reason);
    if (!input || !Number.isInteger(input.version) || !reason) return invalid(res);
    if (!server || !item) {
      sendError(res, 404, 'not_found', 'not found');
      return true;
    }
    if (input.version !== item.lock_version) return conflict(res, 'version_conflict');
    if (item.status === 'installing') return conflict(res, 'busy');
    if (item.status !== 'enabled' && item.status !== 'error') return conflict(res, 'invalid_state');
    const affected = agentsUsing(server.id);
    auditedWrite(
      'mcp.pack.disable.requested',
      {
        pack: server.id,
        pack_version: item.installed_version ?? item.version,
        reason,
        affected_agents: affected.map((agent) => agent.id),
      },
      () => {
        item.status = 'disabling';
        item.status_at = new Date().toISOString();
        item.pending = null;
        item.failed_step = null;
        item.failure = null;
        item.disabled_by = MOCK_USER;
        item.disabled_by_email = MOCK_USER;
        item.disabled_at = item.status_at;
        item.disable_reason = reason;
        item.settle = { at: Date.now() + PROVISION_MS, config: null };
        item.lock_version += 1;
      },
    );
    sendJson(res, 200, catalogView());
    return true;
  }
  if (method !== 'POST') return false;

  if (changeId !== undefined) {
    if (route !== 'enablements') return false;
    const input = await body(req, decision === 'reject' ? ['reason'] : []);
    const reason = reasonOf(input?.reason);
    if (!input || reason === undefined) return invalid(res);
    const pending = item?.pending;
    if (!server || !item || pending?.change_id !== changeId) {
      sendError(res, 404, 'not_found', 'not found');
      return true;
    }
    const own = pending.requested_by === MOCK_USER;
    const detail = {
      pack: server.id,
      change_id: pending.change_id,
      kind: pending.kind,
      pack_version: pending.pack_version,
    };
    if (decision === 'withdraw') {
      if (!own) {
        sendError(res, 403, 'not_requester', 'only the requester can withdraw');
        return true;
      }
    } else if (own) {
      sendError(
        res,
        403,
        decision === 'approve' ? 'same_approver' : 'use_withdraw',
        'the requester cannot decide their own request',
      );
      return true;
    }
    if (decision === 'approve') {
      auditedWrite('mcp.pack.request.approved', { ...detail, approved_by: MOCK_USER }, () => {
        item.pending = null;
        item.requested_by = pending.requested_by;
        item.requested_by_email = pending.requested_by_email;
        item.requested_at = pending.created_at;
        item.approved_by = MOCK_USER;
        item.approved_by_email = MOCK_USER;
        item.approved_at = new Date().toISOString();
        item.disabled_by = null;
        item.disabled_by_email = null;
        item.disabled_at = null;
        item.disable_reason = null;
        startInstall(item, pending.config);
        item.lock_version += 1;
      });
    } else {
      if (decision === 'reject' && pending.kind !== 'params' && reason === null) {
        sendError(res, 422, 'reason_required', 'a reason is required');
        return true;
      }
      const event =
        decision === 'reject' ? 'mcp.pack.request.rejected' : 'mcp.pack.request.withdrawn';
      auditedWrite(event, { ...detail, reason }, () => {
        item.pending = null;
        if (pending.kind === 'enable') {
          item.status = item.disabled_by !== null ? 'disabled' : 'available';
        }
        if (decision === 'reject') {
          item.last_rejected = {
            change_id: pending.change_id,
            kind: pending.kind,
            decided_by: MOCK_USER,
            decided_by_email: MOCK_USER,
            decided_at: new Date().toISOString(),
            reason,
          };
        }
        item.lock_version += 1;
      });
    }
    sendJson(res, 200, catalogView());
    return true;
  }

  const allowed = BODY_KEYS.get(route);
  if (!allowed) return false;
  const input = await body(req, allowed);
  if (!input || !Number.isInteger(input.version)) return invalid(res);
  if (!server || !item) {
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  if (input.version !== item.lock_version) return conflict(res, 'version_conflict');

  if (route === 'retry') {
    if (item.status !== 'error') return conflict(res, 'invalid_state');
    auditedWrite('mcp.pack.retried', { pack: server.id, pack_version: item.version }, () => {
      startInstall(item, null);
      item.lock_version += 1;
    });
    sendJson(res, 200, catalogView());
    return true;
  }
  if (item.pending) return conflict(res, 'pending_exists');

  if (route === 'enablements') {
    const reason = reasonOf(input.reason);
    if (reason === undefined) return invalid(res);
    if (item.status !== 'available' && item.status !== 'disabled') {
      return conflict(res, 'invalid_state');
    }
    const config = configOf(item, input.config ?? {}, defaults(item));
    if (!config) {
      sendError(res, 422, 'invalid_config', 'invalid config');
      return true;
    }
    const installed = servers.filter(
      (other) => other.pack && ['enabled', 'installing', 'error'].includes(other.pack.status),
    ).length;
    if (installed >= MAX_ENABLED_PACKS) return conflict(res, 'too_many_packs');
    propose(server, item, 'enable', config, reason);
  } else if (route === 'params') {
    if (item.status !== 'enabled') return conflict(res, 'invalid_state');
    if (item.update) return conflict(res, 'update_required');
    const current = item.config ?? defaults(item);
    const config = configOf(item, input.config, current);
    if (!config) {
      sendError(res, 422, 'invalid_config', 'invalid config');
      return true;
    }
    if (Object.entries(config).every(([key, value]) => current[key] === value)) {
      sendError(res, 422, 'no_change', 'no change');
      return true;
    }
    propose(server, item, 'params', config, null);
  } else {
    if (item.status !== 'enabled' && item.status !== 'error') return conflict(res, 'invalid_state');
    if (!item.update) return conflict(res, 'up_to_date');
    const current = item.config ?? defaults(item);
    const config = input.config == null ? current : configOf(item, input.config, current);
    if (!config) {
      sendError(res, 422, 'invalid_config', 'invalid config');
      return true;
    }
    propose(server, item, 'update', config, null);
  }
  sendJson(res, 201, catalogView());
  return true;
};
