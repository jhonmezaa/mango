/**
 * Mock routes of the agent review screen: GET /agents/reviews and POST /agents/{id}/versions/{v}/approve, …/reject and …/retry.
 * The agents live in `agents.ts`; the responses follow the generated contract
 * (packages/ts/api-client).
 *
 * The screen also reads GET /agents/{id}/versions/{v}, GET /mcp/catalog and GET /groups. Those
 * routes belong to the Agent Builder mock, which is tried first: the ones here only answer while
 * that screen is not built. GET /agents/org (Org Chart) is left to its own module; without it
 * the screen shows the id of the supervisor instead of its name.
 */
import { diffDefinitions } from './agentDiff.ts';
import { MOCK_USER } from './cognito.ts';
import {
  OTHER_ADMIN,
  agents,
  contentHash,
  publishedVersion,
  versionOf,
  type MockAgent,
  type MockAgentDefinition,
  type MockAgentVersion,
} from './agents.ts';
import { readObject, sendError, sendJson, type ApiHandler } from './http.ts';

const MAX_HISTORY = 100;
const MAX_REASON = 500;
/** The mock "provisioner": an approved version is published after this long. */
const PUBLISH_MS = 2500;
const HISTORY_STATUSES = ['approved', 'failed', 'published', 'retired'];

// --- Responses -------------------------------------------------------------------------------

/** The published definition a version is compared with; null for a new agent. */
function baseOf(agent: MockAgent, version: MockAgentVersion): MockAgentDefinition | null {
  if (agent.published_version === null || agent.published_version === version.number) return null;
  return versionOf(agent, agent.published_version)?.definition ?? null;
}

/** The mock user wrote the version: the API refuses their approval and their rejection. */
function isAuthor(version: MockAgentVersion): boolean {
  return version.created_by === MOCK_USER || version.submitted_by === MOCK_USER;
}

/** `VersionOut` of the contract. The mock evaluates no submit rules: `violations` is empty. */
export function versionOut(agent: MockAgent, version: MockAgentVersion) {
  const base = baseOf(agent, version);
  return {
    agent_id: version.agent_id,
    version: version.number,
    status: version.status,
    revision: version.revision,
    content_hash: version.content_hash,
    base_version: version.base_version,
    created_by: version.created_by,
    created_by_email: version.created_by_email,
    created_at: version.created_at,
    updated_at: version.updated_at,
    submitted_by: version.submitted_by,
    submitted_at: version.submitted_at,
    approved_by: version.approved_by,
    approved_by_email: null,
    approved_at: version.approved_at,
    rejected_by: version.rejected_by,
    rejected_by_email: null,
    rejected_at: version.rejected_at,
    rejection_reason: version.rejection_reason,
    failed_step: version.failed_step,
    failure: version.failure,
    published_at: version.published_at,
    is_author: isAuthor(version),
    agent: {
      status: agent.status,
      lock_version: agent.lock_version,
      published_version: agent.published_version,
      open_version: agent.open_version,
      created_by: agent.created_by,
    },
    definition: version.definition,
    base,
    diff: diffDefinitions(base, version.definition),
    violations: [],
  };
}

/** A draft a reviewer sent back: the history lists it until it is sent again. */
function isRejected(version: MockAgentVersion): boolean {
  return version.status === 'draft' && version.rejection_reason !== null;
}

function decidedAt(agent: MockAgent, version: MockAgentVersion): string {
  if (version.status === 'retired' && agent.retired_at) return agent.retired_at;
  if (isRejected(version) && version.rejected_at) return version.rejected_at;
  return version.published_at ?? version.approved_at ?? version.updated_at;
}

function reviewOut(agent: MockAgent, version: MockAgentVersion, queued: boolean) {
  const { definition } = version;
  const retired = version.status === 'retired';
  // The queue compares with what is published; the history, with the version it started from.
  const startedFrom =
    version.base_version === null
      ? null
      : (versionOf(agent, version.base_version)?.definition ?? null);
  return {
    agent_id: version.agent_id,
    version: version.number,
    status: version.status,
    kind: version.base_version === null ? 'new' : 'change',
    name: definition.name,
    description: definition.description,
    category: definition.category,
    icon: definition.icon,
    color: definition.color,
    content_hash: version.content_hash,
    created_by: version.created_by,
    created_by_email: version.created_by_email,
    submitted_at: version.submitted_at,
    approved_by: version.approved_by,
    approved_by_email: null,
    approved_at: version.approved_at,
    published_at: version.published_at,
    failed_step: version.failed_step,
    rejected_by: version.rejected_by,
    rejected_by_email: null,
    rejected_at: version.rejected_at,
    rejection_reason: version.rejection_reason,
    retired_by: retired ? agent.retired_by : null,
    retired_by_email: null,
    retired_at: retired ? agent.retired_at : null,
    retire_reason: retired ? agent.retire_reason : null,
    decided_at: decidedAt(agent, version),
    changes: diffDefinitions(queued ? baseOf(agent, version) : startedFrom, definition).changes,
    // The mock provisioner always ends: only a failed publication can be retried.
    retryable: version.status === 'failed' && version.content_hash !== null,
    is_author: isAuthor(version),
  };
}

function allVersions(): [MockAgent, MockAgentVersion][] {
  return [...agents.values()].flatMap((agent) =>
    agent.versions.map((version): [MockAgent, MockAgentVersion] => [agent, version]),
  );
}

const at = (value: string | null) => (value ? Date.parse(value) : 0);

function reviews() {
  const versions = allVersions();
  const queue = versions
    .filter(([, version]) => version.status === 'in_review')
    .sort(([, a], [, b]) => at(a.submitted_at) - at(b.submitted_at));
  const history = versions
    .filter(([, version]) => HISTORY_STATUSES.includes(version.status) || isRejected(version))
    .sort(([agentA, a], [agentB, b]) => at(decidedAt(agentB, b)) - at(decidedAt(agentA, a)))
    .slice(0, MAX_HISTORY);
  return {
    queue: queue.map(([agent, version]) => reviewOut(agent, version, true)),
    history: history.map(([agent, version]) => reviewOut(agent, version, false)),
  };
}

// --- Decisions -------------------------------------------------------------------------------

/** What the provisioner does when it ends well: the approved version becomes the published one. */
function publish(agent: MockAgent, version: MockAgentVersion): void {
  if (version.status !== 'approved') return;
  const now = new Date().toISOString();
  const previous = publishedVersion(agent);
  if (previous) previous.status = 'superseded';
  version.status = 'published';
  version.published_at = now;
  version.updated_at = now;
  agent.status = 'published';
  agent.published_version = version.number;
  agent.open_version = null;
  agent.lock_version += 1;
}

function startPublishing(agent: MockAgent, version: MockAgentVersion): void {
  // Never keeps the dev server or a test run alive.
  setTimeout(() => {
    publish(agent, version);
  }, PUBLISH_MS).unref();
}

const HASH = /^[0-9a-f]{64}$/;

function conflict(res: Parameters<ApiHandler>[1], message: string): void {
  sendError(res, 409, 'version_conflict', message);
}

const VERSION_ROUTE =
  /^\/agents\/([a-z0-9]{2,16})\/versions\/([1-9]\d{0,5})(?:\/(approve|reject|retry))?$/;

export const handleAgentReview: ApiHandler = async (req, res, path) => {
  if (path === '/agents/reviews' && req.method === 'GET') {
    sendJson(res, 200, reviews());
    return true;
  }
  if (path === '/mcp/catalog' && req.method === 'GET') {
    sendJson(res, 200, CATALOG);
    return true;
  }
  if (path === '/groups' && req.method === 'GET') {
    sendJson(res, 200, GROUPS);
    return true;
  }
  const match = VERSION_ROUTE.exec(path);
  if (!match) return false;
  const action = match[3];
  if (req.method !== (action ? 'POST' : 'GET')) return false;
  const agent = agents.get(match[1] ?? '');
  const version = agent ? versionOf(agent, Number(match[2])) : null;
  if (!agent || !version) {
    // The mock user is an admin: the API answers 403 to whoever cannot read the version.
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  if (!action) {
    sendJson(res, 200, versionOut(agent, version));
    return true;
  }

  const body = await readObject(req, [action === 'reject' ? 'reason' : 'content_hash']);
  if (!body) {
    sendError(res, 422, 'invalid_request', 'Invalid body');
    return true;
  }
  const now = new Date().toISOString();

  if (action === 'reject') {
    const reason = body['reason'];
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > MAX_REASON) {
      sendError(res, 422, 'invalid_request', 'Invalid reason');
    } else if (version.status !== 'in_review') {
      conflict(res, 'the version is not in review');
    } else if (isAuthor(version)) {
      sendError(res, 403, 'same_approver', 'another administrator must review this version');
    } else {
      // A rejected version goes back to its creator as a draft, with the reason.
      Object.assign(version, {
        status: 'draft',
        content_hash: null,
        submitted_by: null,
        submitted_at: null,
        rejected_by: MOCK_USER,
        rejected_at: now,
        rejection_reason: reason,
        updated_at: now,
      } satisfies Partial<MockAgentVersion>);
      sendJson(res, 200, versionOut(agent, version));
    }
    return true;
  }

  const hash = body['content_hash'];
  if (typeof hash !== 'string' || !HASH.test(hash)) {
    sendError(res, 422, 'invalid_request', 'Invalid content_hash');
  } else if (version.status !== (action === 'approve' ? 'in_review' : 'failed')) {
    conflict(
      res,
      action === 'approve'
        ? 'the version is not in review'
        : 'only a failed version can be retried',
    );
  } else if (hash !== version.content_hash) {
    conflict(res, 'the version changed; review it again');
  } else if (action === 'approve' && isAuthor(version)) {
    sendError(res, 403, 'same_approver', 'another administrator must review this version');
  } else {
    Object.assign(version, {
      status: 'approved',
      // A retry keeps the approver (spec §3).
      approved_by: action === 'approve' ? MOCK_USER : version.approved_by,
      approved_at: action === 'approve' ? now : version.approved_at,
      failed_step: null,
      failure: null,
      updated_at: now,
    } satisfies Partial<MockAgentVersion>);
    startPublishing(agent, version);
    sendJson(res, 200, versionOut(agent, version));
  }
  return true;
};

// --- Reference data the detail reads (until the Agent Builder mock serves it) -----------------

const tool = (name: string, description: string, audience: 'all' | 'central' = 'all') => ({
  ref: `cost-explorer.${name}`,
  name,
  description,
  access: 'read',
  audience,
  central_groups_only: audience === 'central',
});

/** The only connector of the release (connectors/cost-explorer/manifest.json). */
const CATALOG = {
  items: [
    {
      id: 'cost-explorer',
      kind: 'connector',
      name: 'AWS Cost Explorer',
      description:
        'Gasto, pronóstico, anomalías y Savings Plans de las cuentas de AWS que el usuario puede ver.',
      provider: 'Mango',
      data_tier: 'account_data',
      identity_mode: 'per_user',
      enabled: true,
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
        tool('get_savings_plans_utilization', 'Uso y ahorro neto de Savings Plans.', 'central'),
        tool('get_savings_plans_recommendation', 'Recomendación de compra.', 'central'),
      ],
    },
  ],
};

const GROUPS = {
  items: [
    { id: 'bu-finanzas', type: 'area', area: 'finanzas', description: 'Líderes de Finanzas' },
    { id: 'bu-retail', type: 'area', area: 'retail', description: 'Líderes de Retail' },
    { id: 'finops-central', type: 'central', area: null, description: 'FinOps central' },
    { id: 'mango-admin', type: 'central', area: null, description: 'Administradores de Mango' },
    {
      id: 'mango-agent-creator',
      type: 'general',
      area: null,
      description: 'Creadores de agentes',
    },
  ],
};

// --- Seed ------------------------------------------------------------------------------------

/**
 * A change to a published agent waiting for review, written by the other admin: the case the
 * screen exists for (a diff with fields, prompt lines, tools, groups and limits). It is added
 * here, on top of the seeds of `agents.ts`, so that file stays as the other screens expect it.
 */
function seedChangeInReview(): void {
  const agent = agents.get('finops');
  const published = agent ? publishedVersion(agent) : null;
  if (!agent || !published || agent.open_version !== null) return;
  const sample = allVersions().find(([, version]) => version.created_by === OTHER_ADMIN);
  const base = published.definition;
  const definition: MockAgentDefinition = {
    ...base,
    description: 'Analiza el gasto de AWS de tu organización o de tu área.',
    role: 'Analista FinOps senior',
    system_prompt: `${base.system_prompt}\nBefore recommending Savings Plans, check the current coverage.\nAlways include the annualized saving.`,
    tools: [
      ...base.tools.filter((ref) => ref !== 'cost-explorer.get_anomalies'),
      'cost-explorer.get_savings_plans_coverage',
    ].sort(),
    groups: base.groups.filter((group) => group !== 'bu-retail'),
    limits: { ...base.limits, max_iterations: 16 },
  };
  const submitted = new Date(Date.now() - 95 * 60_000).toISOString();
  const number = agent.latest_version + 1;
  agent.versions.push({
    agent_id: agent.agent_id,
    number,
    status: 'in_review',
    revision: 1,
    definition,
    content_hash: contentHash(definition),
    base_version: published.number,
    created_by: OTHER_ADMIN,
    created_by_email: sample?.[1].created_by_email ?? null,
    created_at: submitted,
    updated_at: submitted,
    submitted_by: OTHER_ADMIN,
    submitted_at: submitted,
    approved_by: null,
    approved_at: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    failed_step: null,
    failure: null,
    published_at: null,
  });
  agent.latest_version = number;
  agent.open_version = number;
}
seedChangeInReview();
