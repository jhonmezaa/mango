/**
 * Mock routes of the Agent Builder screen: POST /agents, POST /agents/{id}/versions, GET and PUT
 * /agents/{id}/versions/{v}, POST …/submit, POST …/reopen, GET /models and GET /mcp/catalog.
 * The agents live in `agents.ts`; the responses follow the generated contract
 * (packages/ts/api-client).
 *
 * The Builder also reads GET /groups, answered here, and GET /agents/mine (quotas) and GET
 * /agents/org (supervisors), which the Marketplace and Org Chart mocks answer (`marketplace.ts`,
 * `orgChart.ts`).
 *
 * The submit rules mirror `mango_api.agent_rules` only as far as the screen needs to show them:
 * the real ones run on the server.
 */
import type { ServerResponse } from 'node:http';

import { zAgentDefinitionSchema } from '@mango/api-client/schemas';

import {
  agents,
  contentHash,
  MOCK_MODEL,
  newAgentId,
  publishedVersion,
  ROOT_SUPERVISOR,
  versionOf,
  type MockAgent,
  type MockAgentDefinition,
  type MockAgentVersion,
} from './agents.ts';
import { diffDefinitions } from './agentDiff.ts';
import { MOCK_USER } from './cognito.ts';
import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';
import { catalogTool, catalogView } from './mcpCatalog.ts';

const MAX_DRAFTS = 20;
const MAX_SUBMISSIONS_PER_DAY = 5;
const OPEN_STATUSES = ['draft', 'in_review', 'approved', 'failed'];
const LINE_LIMITS = { name: 40, description: 140, role: 40, category: 24 } as const;
const MAX_PROMPT_CHARS = 12_000;

// --- Catalogs of the mock installation ----------------------------------------------------------
// The MCP catalog (connectors and packs, and what each serves now) lives in `mcpCatalog.ts`.

export const MOCK_MODELS = [
  {
    id: MOCK_MODEL,
    name: 'Mock Sonnet',
    provider: 'Anthropic',
    supports_tools: true,
    context_tokens: 200_000,
    input_usd: '3',
    output_usd: '15',
  },
  {
    id: 'mock.model-fast-v1',
    name: 'Mock Haiku',
    provider: 'Anthropic',
    supports_tools: true,
    context_tokens: 200_000,
    input_usd: '0.8',
    output_usd: '4',
  },
  {
    id: 'mock.model-text-v1',
    name: 'Mock Text',
    provider: 'Amazon',
    supports_tools: false,
    context_tokens: null,
    input_usd: '0.2',
    output_usd: '0.6',
  },
] as const;

export const MOCK_GROUPS = [
  { id: 'finops-central', type: 'central', area: null, description: 'FinOps central' },
  { id: 'mango-admin', type: 'central', area: null, description: 'Administradores de Mango' },
  { id: 'bu-finanzas', type: 'area', area: 'finanzas', description: 'Líderes de Finanzas' },
  { id: 'bu-retail', type: 'area', area: 'retail', description: 'Líderes de Retail' },
  { id: 'toda-la-empresa', type: 'general', area: null, description: 'Toda la organización' },
] as const;

// --- Submit rules ---------------------------------------------------------------------------

interface Violation {
  code: string;
  field: string;
  items: string[];
}

const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['aws_access_key_id', /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/],
  ['aws_secret_access_key', /aws_?secret_?access_?key\s*[:=]/i],
  ['private_key', /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/],
  ['api_key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['password', /\b(?:password|passwd|pwd|contraseña)\s*[:=]\s*\S{4,}/i],
];

function supervisorOf(agentId: string): string | null {
  const agent = agents.get(agentId);
  const version = agent ? publishedVersion(agent) : null;
  return version ? (version.definition.reports_to ?? ROOT_SUPERVISOR) : null;
}

function organizationRule(agentId: string, definition: MockAgentDefinition): Violation[] {
  const supervisor = definition.reports_to;
  if (supervisor === null || supervisor === ROOT_SUPERVISOR) return [];
  const cycle = [{ code: 'reports_to_cycle', field: 'reports_to', items: [supervisor] }];
  if (supervisor === agentId) return cycle;
  let current = supervisorOf(supervisor);
  if (current === null) {
    return [{ code: 'reports_to_unknown', field: 'reports_to', items: [supervisor] }];
  }
  const seen = new Set([supervisor]);
  while (current !== null && current !== ROOT_SUPERVISOR) {
    if (current === agentId || seen.has(current)) return cycle;
    seen.add(current);
    current = supervisorOf(current);
  }
  return [];
}

export function validateForReview(agentId: string, definition: MockAgentDefinition): Violation[] {
  const out: Violation[] = [];
  const add = (code: string, field: string, items: string[] = []) =>
    out.push({ code, field, items });
  if (!definition.system_prompt.trim()) add('prompt_required', 'system_prompt');
  if (definition.reports_to === null) add('reports_to_required', 'reports_to');
  if (!definition.role) add('role_required', 'role');
  if (definition.groups.length === 0) add('groups_required', 'groups');
  for (const field of ['system_prompt', 'name', 'description', 'role'] as const) {
    const kinds = SECRET_PATTERNS.filter(([, pattern]) => pattern.test(definition[field]));
    // The kind of secret, never the match.
    if (kinds.length > 0)
      add(
        'secret_detected',
        field,
        kinds.map(([kind]) => kind),
      );
  }
  out.push(...organizationRule(agentId, definition));

  if (definition.model === null) {
    add('model_required', 'model');
  } else {
    if (!definition.allowed_models.includes(definition.model)) {
      add('default_model_not_allowed', 'allowed_models', [definition.model]);
    }
    const known = new Map<string, { supports_tools: boolean }>(
      MOCK_MODELS.map((model) => [model.id, model]),
    );
    const disabled = definition.allowed_models.filter((id) => !known.has(id));
    if (disabled.length > 0) add('model_not_enabled', 'allowed_models', disabled);
    const noTools = definition.allowed_models.filter(
      (id) => known.get(id)?.supports_tools === false,
    );
    if (definition.tools.length > 0 && noTools.length > 0) {
      add('model_without_tools', 'allowed_models', noTools);
    }
  }

  const unavailable = definition.tools.filter((ref) => !catalogTool(ref)?.enabled);
  if (unavailable.length > 0) add('tool_not_enabled', 'tools', unavailable);
  const stray = definition.approval_tools.filter((ref) => !definition.tools.includes(ref));
  if (stray.length > 0) add('approval_tool_not_selected', 'approval_tools', stray);
  const unmarked = definition.tools.filter(
    (ref) => catalogTool(ref)?.write && !definition.approval_tools.includes(ref),
  );
  if (unmarked.length > 0) add('write_tool_without_approval', 'approval_tools', unmarked);

  const groups = new Map<string, { type: string }>(MOCK_GROUPS.map((group) => [group.id, group]));
  const unknown = definition.groups.filter((id) => !groups.has(id));
  if (unknown.length > 0) add('group_unknown', 'groups', unknown);
  if (definition.tools.some((ref) => catalogTool(ref)?.centralOnly)) {
    const exposed = definition.groups.filter((id) => groups.get(id)?.type !== 'central');
    if (exposed.length > 0) add('account_data_for_non_central_group', 'groups', exposed);
    if (definition.users.length > 0) add('account_data_for_users', 'users');
  }
  return out;
}

// --- Mapping --------------------------------------------------------------------------------

function isAuthor(version: MockAgentVersion): boolean {
  return version.created_by === MOCK_USER || version.submitted_by === MOCK_USER;
}

/** `VersionOut` of the contract. The diff is against the version published now. */
export function versionOut(agent: MockAgent, version: MockAgentVersion) {
  const published = versionOf(agent, agent.published_version);
  const base = published && published.number !== version.number ? published.definition : null;
  return {
    agent_id: agent.agent_id,
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
    violations: OPEN_STATUSES.includes(version.status)
      ? validateForReview(agent.agent_id, version.definition)
      : [],
  };
}

function myOpenVersions(): MockAgentVersion[] {
  return [...agents.values()].flatMap((agent) =>
    agent.versions.filter(
      (version) => version.created_by === MOCK_USER && OPEN_STATUSES.includes(version.status),
    ),
  );
}

function submissionsToday(): number {
  const today = new Date().toISOString().slice(0, 10);
  return [...agents.values()]
    .flatMap((agent) => agent.versions)
    .filter(
      (version) => version.submitted_by === MOCK_USER && version.submitted_at?.startsWith(today),
    ).length;
}

function secondsToNextUtcDay(): number {
  const now = new Date();
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.floor((tomorrow - now.getTime()) / 1000));
}

// --- Requests -------------------------------------------------------------------------------

const sortedUnique = (values: string[]) => [...new Set(values)].sort();

/** The definition as the backend stores it, or null when it is not valid (422). */
function parseDefinition(value: unknown): MockAgentDefinition | null {
  const parsed = zAgentDefinitionSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  const lines = {
    name: data.name.trim(),
    description: data.description.trim(),
    role: data.role.trim(),
    category: data.category.trim(),
  };
  const tooLong = (Object.keys(LINE_LIMITS) as (keyof typeof LINE_LIMITS)[]).some(
    (field) => lines[field].length > LINE_LIMITS[field] || /[\r\n]/.test(lines[field]),
  );
  if (tooLong || lines.name.length === 0 || data.system_prompt.length > MAX_PROMPT_CHARS) {
    return null;
  }
  return {
    ...lines,
    icon: data.icon,
    color: data.color,
    reports_to: data.reports_to ?? null,
    model: data.model ?? null,
    allowed_models: sortedUnique(data.allowed_models),
    system_prompt: data.system_prompt,
    tools: sortedUnique(data.tools),
    approval_tools: sortedUnique(data.approval_tools),
    limits: {
      max_tokens: data.limits.max_tokens,
      max_iterations: data.limits.max_iterations,
      timeout_seconds: data.limits.timeout_seconds,
      max_tokens_per_call: data.limits.max_tokens_per_call ?? null,
      temperature: data.limits.temperature ?? null,
    },
    groups: sortedUnique(data.groups),
    users: sortedUnique(data.users),
  };
}

async function jsonBody(req: Parameters<ApiHandler>[0]): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = JSON.parse((await readBody(req)) || '{}');
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const invalid = (res: ServerResponse) => {
  sendError(res, 422, 'invalid_request', 'Invalid request');
};
const conflict = (res: ServerResponse, message: string) => {
  sendError(res, 409, 'version_conflict', message);
};

function newDraft(
  agentId: string,
  number: number,
  definition: MockAgentDefinition,
  baseVersion: number | null,
): MockAgentVersion {
  const now = new Date().toISOString();
  return {
    agent_id: agentId,
    number,
    status: 'draft',
    revision: 1,
    definition,
    content_hash: null,
    base_version: baseVersion,
    created_by: MOCK_USER,
    created_by_email: MOCK_USER,
    created_at: now,
    updated_at: now,
    submitted_by: null,
    submitted_at: null,
    approved_by: null,
    approved_at: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    failed_step: null,
    failure: null,
    published_at: null,
  };
}

async function createAgent(req: Parameters<ApiHandler>[0], res: ServerResponse): Promise<void> {
  const body = await jsonBody(req);
  const definition = body ? parseDefinition(body.definition) : null;
  if (!definition) {
    invalid(res);
    return;
  }
  if (myOpenVersions().filter((version) => version.status === 'draft').length >= MAX_DRAFTS) {
    sendError(res, 409, 'too_many_drafts', 'too many drafts; send or delete some first');
    return;
  }
  const agentId = newAgentId();
  const version = newDraft(agentId, 1, definition, null);
  const agent: MockAgent = {
    agent_id: agentId,
    status: 'draft',
    lock_version: 1,
    latest_version: 1,
    open_version: 1,
    published_version: null,
    created_by: MOCK_USER,
    created_at: version.created_at,
    retired_by: null,
    retired_at: null,
    retire_reason: null,
    versions: [version],
  };
  agents.set(agentId, agent);
  sendJson(res, 201, versionOut(agent, version));
}

function createVersion(res: ServerResponse, agent: MockAgent): void {
  const published = publishedVersion(agent);
  if (!published) {
    conflict(res, 'only a published agent gets a new version');
    return;
  }
  if (agent.open_version !== null) {
    conflict(res, 'the agent changed; reload and try again');
    return;
  }
  const version = newDraft(
    agent.agent_id,
    agent.latest_version + 1,
    published.definition,
    published.number,
  );
  agent.versions.push(version);
  agent.latest_version = version.number;
  agent.open_version = version.number;
  sendJson(res, 201, versionOut(agent, version));
}

/** The draft the request may change, or null after answering 409. */
function requireDraft(
  res: ServerResponse,
  version: MockAgentVersion,
  revision: unknown,
): revision is number {
  if (version.status !== 'draft') {
    conflict(res, 'only drafts can be changed');
    return false;
  }
  if (version.revision !== revision) {
    conflict(res, 'the draft changed; reload and try again');
    return false;
  }
  return true;
}

async function saveDraft(
  req: Parameters<ApiHandler>[0],
  res: ServerResponse,
  agent: MockAgent,
  version: MockAgentVersion,
): Promise<void> {
  const body = await jsonBody(req);
  const definition = body ? parseDefinition(body.definition) : null;
  if (!body || !definition || !Number.isInteger(body.revision)) {
    invalid(res);
    return;
  }
  if (!requireDraft(res, version, body.revision)) return;
  version.definition = definition;
  version.revision += 1;
  version.updated_at = new Date().toISOString();
  sendJson(res, 200, versionOut(agent, version));
}

async function submit(
  req: Parameters<ApiHandler>[0],
  res: ServerResponse,
  agent: MockAgent,
  version: MockAgentVersion,
): Promise<void> {
  const body = await jsonBody(req);
  if (!body || !Number.isInteger(body.revision)) {
    invalid(res);
    return;
  }
  if (!requireDraft(res, version, body.revision)) return;
  const violations = validateForReview(agent.agent_id, version.definition);
  if (violations.length > 0) {
    sendJson(res, 422, {
      error: { code: 'validation_failed', message: 'the version does not meet the review rules' },
      violations,
    });
    return;
  }
  if (submissionsToday() >= MAX_SUBMISSIONS_PER_DAY) {
    sendError(res, 429, 'submission_limit', 'daily limit of versions sent to review reached', {
      'Retry-After': String(secondsToNextUtcDay()),
    });
    return;
  }
  const now = new Date().toISOString();
  version.status = 'in_review';
  version.content_hash = contentHash(version.definition);
  version.submitted_by = MOCK_USER;
  version.submitted_at = now;
  version.updated_at = now;
  version.rejected_by = null;
  version.rejected_at = null;
  version.rejection_reason = null;
  sendJson(res, 200, versionOut(agent, version));
}

function reopen(res: ServerResponse, agent: MockAgent, version: MockAgentVersion): void {
  if (version.status !== 'failed') {
    conflict(res, 'only a failed version can be reopened');
    return;
  }
  version.status = 'draft';
  version.revision += 1;
  version.content_hash = null;
  version.approved_by = null;
  version.approved_at = null;
  version.updated_at = new Date().toISOString();
  sendJson(res, 200, versionOut(agent, version));
}

const VERSION_PATH = /^\/agents\/([a-z0-9]{2,16})\/versions(?:\/(\d{1,6})(?:\/(submit|reopen))?)?$/;

export const handleAgentBuilder: ApiHandler = async (req, res, path) => {
  const { method } = req;
  if (method === 'GET') {
    if (path === '/models') {
      sendJson(res, 200, { version: 1, items: MOCK_MODELS });
      return true;
    }
    if (path === '/mcp/catalog') {
      sendJson(res, 200, catalogView());
      return true;
    }
    if (path === '/groups') {
      sendJson(res, 200, { items: MOCK_GROUPS });
      return true;
    }
  }
  if (path === '/agents' && method === 'POST') {
    await createAgent(req, res);
    return true;
  }

  const match = VERSION_PATH.exec(path);
  if (!match) return false;
  const [, agentId = '', number, action] = match;
  const agent = agents.get(agentId);
  if (!agent) {
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  if (number === undefined) {
    if (method !== 'POST') return false;
    createVersion(res, agent);
    return true;
  }
  const version = versionOf(agent, Number(number));
  if (!version) {
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  if (action === undefined && method === 'GET') {
    sendJson(res, 200, versionOut(agent, version));
  } else if (action === undefined && method === 'PUT') {
    await saveDraft(req, res, agent, version);
  } else if (action === 'submit' && method === 'POST') {
    await submit(req, res, agent, version);
  } else if (action === 'reopen' && method === 'POST') {
    reopen(res, agent, version);
  } else {
    return false;
  }
  return true;
};
