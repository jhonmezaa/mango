/**
 * Mock routes of the remote MCP services (docs/specs/poc-api-contract.md, «MCP remotos»): GET
 * /mcp/remotes and the requests to enable, change, approve, rotate and disable a registration.
 * In-memory state in the generated contract (packages/ts/api-client).
 *
 * Differences with the API, on purpose: the "provisioner" finishes by itself a few seconds after
 * an approval, and the client secret is checked for shape and then dropped (the API hands it to
 * AgentCore Identity and never stores it either). Ids and URLs are placeholders.
 */
import { randomBytes } from 'node:crypto';

import { OTHER_ADMIN } from './agents.ts';
import { auditedWrite } from './audit.ts';
import { MOCK_USER } from './cognito.ts';
import { registeredGroupIds } from './groups.ts';
import { readBody, readObject, sendError, sendJson, type ApiHandler } from './http.ts';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const REQUEST_TTL_MS = 7 * DAY_MS;
/** How long the mock "provisioner" takes to create or remove a registration. */
const PROVISION_MS = 4000;
const OTHER_ADMIN_EMAIL = 'otra.admin@example.com';
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,48}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SECRET_DAYS = 730;

type RegStatus =
  'pending' | 'approved' | 'creating' | 'active' | 'failed' | 'disabling' | 'disabled';
type ChangeKind = 'enable' | 'replace_app' | 'params';
type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'cancelled';

/** The profile of the release (remotes/azure-devops/profile.yaml), as the API shows it. */
const PROFILE = {
  id: 'azure-devops',
  version: '2026.10.27-1',
  name: 'Azure DevOps',
  operator: 'Microsoft',
  provider: 'Microsoft',
  host: 'mcp.dev.azure.com',
  link_hosts: ['dev.azure.com', 'visualstudio.com'],
  data_leaves_aws: true,
  needs_tenant: true,
  permissions: [
    { resource: 'Azure DevOps MCP', permission: '.default (delegado, lectura)' },
    { resource: 'Microsoft Entra', permission: 'offline_access' },
  ],
  toolsets: [
    {
      id: 'core',
      label: 'Proyectos y equipos',
      always: true,
      tools: ['core_list_project_teams', 'core_list_projects'],
    },
    {
      id: 'pipelines',
      label: 'Pipelines',
      always: false,
      tools: ['pipelines_build', 'pipelines_build_log', 'pipelines_definition', 'pipelines_run'],
    },
    { id: 'search-code', label: 'Búsqueda de código', always: false, tools: ['search_code'] },
    { id: 'wiki', label: 'Wiki', always: false, tools: ['search_wiki', 'wiki'] },
    {
      id: 'wit',
      label: 'Work items',
      always: false,
      tools: ['search_workitem', 'wit_backlog', 'wit_query', 'wit_work_item'],
    },
  ],
};

interface MockChange {
  id: string;
  kind: ChangeKind;
  status: ChangeStatus;
  organization: string;
  tenant_id: string;
  client_id: string;
  callback_url: string;
  secret_expires_on: string;
  toolsets: string[];
  groups: string[];
  requested_by: string;
  requested_by_email: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_reason: string | null;
}

interface MockRegistration {
  id: string;
  organization: string;
  status: RegStatus;
  version: number;
  toolsets: string[];
  groups: string[];
  tenant_id: string;
  client_id: string;
  callback_url: string;
  secret_expires_on: string;
  requested_by: string;
  requested_by_email: string;
  approved_by: string | null;
  approved_by_email: string | null;
  approved_at: string | null;
  disabled_by: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
  pending: MockChange | null;
  history: MockChange[];
  /** When the mock provisioner finishes, and with what. */
  settle: { at: number; to: RegStatus; change: MockChange | null } | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function day(offsetDays: number): string {
  return iso(Date.now() + offsetDays * DAY_MS).slice(0, 10);
}

function registrationId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return [...randomBytes(12)].map((byte) => alphabet[byte % 32]).join('');
}

function callbackUrl(): string {
  // Placeholder of the URL AgentCore Identity returns for a provider (D93 (6)).
  return `https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/${randomBytes(16).toString('hex')}`;
}

function change(
  kind: ChangeKind,
  by: string,
  byEmail: string,
  hoursAgo: number,
  base: Pick<MockChange, 'organization' | 'toolsets' | 'groups'>,
): MockChange {
  const created = Date.now() - hoursAgo * HOUR_MS;
  return {
    id: randomBytes(16).toString('hex'),
    kind,
    status: 'pending',
    tenant_id: '00000000-0000-4000-8000-000000000001',
    client_id: '00000000-0000-4000-8000-000000000002',
    callback_url: callbackUrl(),
    secret_expires_on: day(180),
    requested_by: by,
    requested_by_email: byEmail,
    created_at: iso(created),
    expires_at: iso(created + REQUEST_TTL_MS),
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    decision_reason: null,
    ...base,
  };
}

function seedActive(): MockRegistration {
  const base = {
    organization: 'empresa',
    toolsets: ['core', 'wiki', 'wit'],
    groups: ['finops-central', 'mango-agent-creator'],
  };
  const withdrawn: MockChange = {
    ...change('replace_app', OTHER_ADMIN, OTHER_ADMIN_EMAIL, 22 * 24, base),
    status: 'withdrawn',
    decided_by: OTHER_ADMIN,
    decided_by_email: OTHER_ADMIN_EMAIL,
    decided_at: iso(Date.now() - 22 * DAY_MS),
  };
  const rejected: MockChange = {
    ...change('replace_app', OTHER_ADMIN, OTHER_ADMIN_EMAIL, 26 * 24, base),
    status: 'rejected',
    decided_by: MOCK_USER,
    decided_by_email: MOCK_USER,
    decided_at: iso(Date.now() - 25 * DAY_MS),
    // Plain text on screen, never HTML.
    decision_reason: 'La app de Entra pedía permisos de <b>escritura</b>',
  };
  return {
    id: registrationId(),
    status: 'active',
    version: 3,
    tenant_id: '00000000-0000-4000-8000-000000000001',
    client_id: '00000000-0000-4000-8000-000000000003',
    callback_url: callbackUrl(),
    secret_expires_on: day(21),
    requested_by: OTHER_ADMIN,
    requested_by_email: OTHER_ADMIN_EMAIL,
    approved_by: MOCK_USER,
    approved_by_email: MOCK_USER,
    approved_at: iso(Date.now() - 19 * DAY_MS),
    disabled_by: null,
    disabled_at: null,
    disabled_reason: null,
    pending: null,
    history: [withdrawn, rejected],
    settle: null,
    ...base,
  };
}

function seedPending(): MockRegistration {
  const base = {
    organization: 'empresa-labs',
    toolsets: ['core', 'wit'],
    groups: ['finops-central'],
  };
  const pending = change('enable', OTHER_ADMIN, OTHER_ADMIN_EMAIL, 3, base);
  return {
    id: registrationId(),
    status: 'pending',
    version: 0,
    tenant_id: pending.tenant_id,
    client_id: pending.client_id,
    callback_url: pending.callback_url,
    secret_expires_on: pending.secret_expires_on,
    requested_by: OTHER_ADMIN,
    requested_by_email: OTHER_ADMIN_EMAIL,
    approved_by: null,
    approved_by_email: null,
    approved_at: null,
    disabled_by: null,
    disabled_at: null,
    disabled_reason: null,
    pending,
    history: [],
    settle: null,
    ...base,
  };
}

const registrations: MockRegistration[] = [seedActive(), seedPending()];

function settle(): void {
  const now = Date.now();
  for (const reg of registrations) {
    if (!reg.settle || reg.settle.at > now) continue;
    const { to, change: applied } = reg.settle;
    reg.status = to;
    reg.settle = null;
    if (applied && to === 'active') {
      reg.tenant_id = applied.tenant_id;
      reg.client_id = applied.client_id;
      reg.callback_url = applied.callback_url;
      reg.secret_expires_on = applied.secret_expires_on;
      reg.toolsets = applied.toolsets;
      reg.groups = applied.groups;
    }
    reg.version += 1;
  }
}

function secretLevel(expires: string): 'ok' | 'd30' | 'd7' | 'expired' {
  const days = Math.round(
    (Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${day(0)}T00:00:00Z`)) / DAY_MS,
  );
  if (days < 0) return 'expired';
  return days <= 7 ? 'd7' : days <= 30 ? 'd30' : 'ok';
}

function changeOut(item: MockChange) {
  return {
    ...item,
    registration_id:
      registrations.find((reg) => reg.pending === item || reg.history.includes(item))?.id ?? '',
    profile_id: PROFILE.id,
    profile_version: PROFILE.version,
    previous_toolsets: null,
    previous_groups: null,
    reason: null,
    own: item.requested_by === MOCK_USER,
  };
}

function view() {
  settle();
  return {
    enabled: true,
    profiles: [{ ...PROFILE, enabled_in_installation: true }],
    max_registrations: 10,
    registrations: registrations.map((reg) => ({
      id: reg.id,
      profile_id: PROFILE.id,
      profile_in_release: true,
      organization: reg.organization,
      toolsets: reg.toolsets,
      groups: reg.groups,
      status: reg.status,
      tools:
        reg.status === 'active'
          ? PROFILE.toolsets
              .filter((t) => reg.toolsets.includes(t.id))
              .flatMap((t) => t.tools)
              .sort()
          : [],
      secret_expires_on: reg.status === 'pending' ? null : reg.secret_expires_on,
      secret_level: reg.status === 'pending' ? null : secretLevel(reg.secret_expires_on),
      disabled_by: reg.disabled_by,
      disabled_at: reg.disabled_at,
      reason: reg.disabled_reason,
      version: reg.version,
      tenant_id: reg.tenant_id,
      client_id: reg.client_id,
      callback_url: reg.callback_url,
      requested_by: reg.requested_by,
      requested_by_email: reg.requested_by_email,
      approved_by: reg.approved_by,
      approved_by_email: reg.approved_by_email,
      approved_at: reg.approved_at,
      failure_code: reg.status === 'failed' ? 'target_failed' : null,
      pending: reg.pending ? changeOut(reg.pending) : null,
      history: reg.history.map(changeOut),
    })),
  };
}

/** A registration as the person's side of the mock sees it (Mis conexiones, Builder, chat). */
export interface UsableRemote {
  id: string;
  organization: string;
  status: 'active' | 'disabled';
  secretExpired: boolean;
  tools: string[];
}

/** The mock profile's names, for the person's side. */
export const REMOTE_PROFILE = {
  id: PROFILE.id,
  name: PROFILE.name,
  operator: PROFILE.operator,
  provider: PROFILE.provider,
  link_hosts: PROFILE.link_hosts,
};

/** Registrations the caller may use (`UseRemoteMcp`): active or disabled, of their groups. */
export function usableRemotes(groups: readonly string[]): UsableRemote[] {
  settle();
  return registrations.flatMap((reg) =>
    (reg.status === 'active' || reg.status === 'disabled') &&
    reg.groups.some((group) => groups.includes(group))
      ? [
          {
            id: reg.id,
            organization: reg.organization,
            status: reg.status,
            secretExpired: secretLevel(reg.secret_expires_on) === 'expired',
            tools: PROFILE.toolsets
              .filter((t) => reg.toolsets.includes(t.id))
              .flatMap((t) => t.tools)
              .sort(),
          },
        ]
      : [],
  );
}

// --- Validation ---------------------------------------------------------------------------------

function appOf(
  input: Record<string, unknown>,
): Pick<MockChange, 'tenant_id' | 'client_id' | 'secret_expires_on'> | null {
  const {
    tenant_id: tenant,
    client_id: client,
    client_secret: secret,
    secret_expires_on: expires,
  } = input;
  if (typeof tenant !== 'string' || !UUID.test(tenant)) return null;
  if (typeof client !== 'string' || !UUID.test(client)) return null;
  // The secret is checked and dropped: nothing in the mock keeps it.
  if (typeof secret !== 'string' || secret.length < 1 || secret.length > 512) return null;
  if (typeof expires !== 'string' || !DAY.test(expires)) return null;
  if (!(expires > day(0) && expires <= day(MAX_SECRET_DAYS))) return null;
  return {
    tenant_id: tenant.toLowerCase(),
    client_id: client.toLowerCase(),
    secret_expires_on: expires,
  };
}

function listOf(value: unknown, allowed: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((item): item is string => typeof item === 'string' && allowed.includes(item))) {
    return null;
  }
  return [...new Set(value)].sort();
}

function toolsetsOf(value: unknown): string[] | null {
  const picked = listOf(
    value,
    PROFILE.toolsets.map((toolset) => toolset.id),
  );
  if (!picked) return null;
  const always = PROFILE.toolsets.filter((toolset) => toolset.always).map((toolset) => toolset.id);
  return [...new Set([...picked, ...always])].sort();
}

const invalid: ApiHandler = (_req, res) => {
  sendError(res, 422, 'invalid_request', 'invalid request');
  return Promise.resolve(true);
};

function live(reg: MockRegistration): boolean {
  return reg.status !== 'disabled';
}

const ROUTE =
  /^\/mcp\/remotes\/registrations\/([a-z2-7]{12})(?:\/(requests|secret|retry|params)(?:\/([0-9a-f]{32})\/(approve|reject|withdraw))?)?$/;

export const handleRemoteMcp: ApiHandler = async (req, res, path, url) => {
  const { method } = req;
  if (path === '/mcp/remotes') {
    if (method !== 'GET') return false;
    sendJson(res, 200, view());
    return true;
  }
  const create = /^\/mcp\/remotes\/([a-z][a-z0-9-]{1,23})\/registrations$/.exec(path);
  if (create) {
    if (method !== 'POST') return false;
    settle();
    if (create[1] !== PROFILE.id) {
      sendError(res, 409, 'remote_profile_not_in_release', 'not in this release');
      return true;
    }
    const input = await readObject(req, [
      'organization',
      'tenant_id',
      'client_id',
      'client_secret',
      'secret_expires_on',
      'toolsets',
      'groups',
      'reason',
    ]);
    const organization = input?.organization;
    const app = input ? appOf(input) : null;
    const toolsets = toolsetsOf(input?.toolsets);
    const groups = listOf(input?.groups, registeredGroupIds());
    if (
      !input ||
      typeof organization !== 'string' ||
      !ORGANIZATION.test(organization) ||
      !app ||
      !toolsets ||
      !groups
    ) {
      return invalid(req, res, path, url);
    }
    if (
      registrations.some((reg) => reg.organization.toLowerCase() === organization.toLowerCase())
    ) {
      sendError(res, 409, 'remote_exists', 'already registered');
      return true;
    }
    const pending = {
      ...change('enable', MOCK_USER, MOCK_USER, 0, { organization, toolsets, groups }),
      ...app,
    };
    auditedWrite(
      'mcp_remote.request',
      { profile: PROFILE.id, kind: 'enable', organization },
      () => {
        registrations.push({
          id: registrationId(),
          organization,
          status: 'pending',
          version: 0,
          toolsets,
          groups,
          ...app,
          callback_url: pending.callback_url,
          requested_by: MOCK_USER,
          requested_by_email: MOCK_USER,
          approved_by: null,
          approved_by_email: null,
          approved_at: null,
          disabled_by: null,
          disabled_at: null,
          disabled_reason: null,
          pending,
          history: [],
          settle: null,
        });
      },
    );
    sendJson(res, 201, view());
    return true;
  }

  const match = ROUTE.exec(path);
  if (!match) return false;
  const [, regId, route, changeId, decision] = match;
  settle();
  const reg = registrations.find((item) => item.id === regId);

  if (route === undefined) {
    if (method !== 'DELETE') return false;
    const input = await readObject(req, ['version', 'reason']);
    if (
      !input ||
      !Number.isInteger(input.version) ||
      typeof input.reason !== 'string' ||
      !input.reason.trim()
    ) {
      return invalid(req, res, path, url);
    }
    if (!reg) return notFound(res);
    if (input.version !== reg.version) return conflict(res, 'version_conflict');
    if (reg.status !== 'active' && reg.status !== 'failed') return conflict(res, 'invalid_state');
    const reason = input.reason;
    auditedWrite('mcp_remote.disable', { registration: reg.id, reason }, () => {
      reg.status = 'disabling';
      reg.disabled_by = MOCK_USER;
      reg.disabled_at = new Date().toISOString();
      reg.disabled_reason = reason;
      reg.settle = { at: Date.now() + PROVISION_MS, to: 'disabled', change: null };
      reg.version += 1;
    });
    sendJson(res, 200, view());
    return true;
  }
  if (method !== 'POST') return false;
  if (!reg) return notFound(res);

  if (changeId !== undefined) {
    if (route !== 'requests') return false;
    const input = await readObject(req, decision === 'reject' ? ['reason'] : []);
    if (!input) return invalid(req, res, path, url);
    const pending = reg.pending;
    if (pending?.id !== changeId) return notFound(res);
    const own = pending.requested_by === MOCK_USER;
    if (decision === 'withdraw' && !own) {
      sendError(res, 403, 'not_requester', 'only who asked can withdraw');
      return true;
    }
    if (decision !== 'withdraw' && own) {
      sendError(
        res,
        403,
        decision === 'approve' ? 'same_approver' : 'use_withdraw',
        'not yours to decide',
      );
      return true;
    }
    if (decision === 'reject' && (typeof input.reason !== 'string' || !input.reason.trim())) {
      return invalid(req, res, path, url);
    }
    const now = new Date().toISOString();
    if (decision === 'approve') {
      auditedWrite('mcp_remote.approve', { registration: reg.id, change: pending.id }, () => {
        pending.status = 'approved';
        pending.decided_by = MOCK_USER;
        pending.decided_by_email = MOCK_USER;
        pending.decided_at = now;
        reg.history.unshift(pending);
        reg.pending = null;
        reg.approved_by = MOCK_USER;
        reg.approved_by_email = MOCK_USER;
        reg.approved_at = now;
        reg.status = 'creating';
        reg.disabled_by = null;
        reg.disabled_at = null;
        reg.disabled_reason = null;
        reg.settle = { at: Date.now() + PROVISION_MS, to: 'active', change: pending };
        reg.version += 1;
      });
    } else {
      const event = decision === 'reject' ? 'mcp_remote.reject' : 'mcp_remote.withdraw';
      auditedWrite(event, { registration: reg.id, change: pending.id }, () => {
        pending.status = decision === 'reject' ? 'rejected' : 'withdrawn';
        pending.decided_by = MOCK_USER;
        pending.decided_by_email = MOCK_USER;
        pending.decided_at = now;
        pending.decision_reason = decision === 'reject' ? String(input.reason) : null;
        reg.pending = null;
        reg.version += 1;
        // The first request of a registration that was never approved takes it away (API).
        if (reg.status === 'pending') registrations.splice(registrations.indexOf(reg), 1);
        else reg.history.unshift(pending);
      });
    }
    sendJson(res, 200, view());
    return true;
  }

  if (route === 'secret') {
    const input = await readObject(req, ['version', 'client_secret', 'secret_expires_on']);
    const secret = input?.client_secret;
    const expires = input?.secret_expires_on;
    if (
      !input ||
      !Number.isInteger(input.version) ||
      typeof secret !== 'string' ||
      !secret ||
      secret.length > 512 ||
      typeof expires !== 'string' ||
      !DAY.test(expires) ||
      !(expires > day(0) && expires <= day(MAX_SECRET_DAYS))
    ) {
      return invalid(req, res, path, url);
    }
    if (input.version !== reg.version) return conflict(res, 'version_conflict');
    if (reg.status !== 'active') return conflict(res, 'invalid_state');
    auditedWrite(
      'mcp_remote.secret_rotated',
      { registration: reg.id, secret_expires_on: expires },
      () => {
        reg.secret_expires_on = expires;
        reg.version += 1;
      },
    );
    sendJson(res, 200, view());
    return true;
  }

  if (route === 'requests') {
    const kind = await readKind(req);
    if (!kind) return invalid(req, res, path, url);
    const { input } = kind;
    const app = appOf(input);
    if (!app || !Number.isInteger(input.version)) return invalid(req, res, path, url);
    if (input.version !== reg.version) return conflict(res, 'version_conflict');
    if (reg.pending) return conflict(res, 'pending_exists');
    let toolsets = reg.toolsets;
    let groups = reg.groups;
    if (kind.kind === 'replace_app') {
      if (reg.status !== 'active') return conflict(res, 'invalid_state');
    } else {
      if (reg.status !== 'failed' && reg.status !== 'disabled')
        return conflict(res, 'invalid_state');
      const pickedToolsets = toolsetsOf(input.toolsets);
      const pickedGroups = listOf(input.groups, registeredGroupIds());
      if (!pickedToolsets || !pickedGroups) return invalid(req, res, path, url);
      toolsets = pickedToolsets;
      groups = pickedGroups;
      if (reg.status === 'disabled' && registrations.filter(live).length >= 10) {
        return conflict(res, 'too_many_remotes');
      }
    }
    const pending = {
      ...change(kind.kind, MOCK_USER, MOCK_USER, 0, {
        organization: reg.organization,
        toolsets,
        groups,
      }),
      ...app,
    };
    auditedWrite('mcp_remote.request', { registration: reg.id, kind: kind.kind }, () => {
      reg.pending = pending;
      reg.version += 1;
    });
    sendJson(res, 201, view());
    return true;
  }
  return false;
};

/** The body of `.../requests`: `replace_app` or `enable`, each with exactly its fields. */
async function readKind(
  req: Parameters<ApiHandler>[0],
): Promise<{ kind: 'replace_app' | 'enable'; input: Record<string, unknown> } | null> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const app = [
    'client_id',
    'client_secret',
    'kind',
    'reason',
    'secret_expires_on',
    'tenant_id',
    'version',
  ];
  const keys = Object.keys(input).sort().join(',');
  if (input.kind === 'replace_app' && keys === app.join(',')) return { kind: 'replace_app', input };
  if (input.kind === 'enable' && keys === [...app, 'groups', 'toolsets'].sort().join(',')) {
    return { kind: 'enable', input };
  }
  return null;
}

function notFound(res: Parameters<ApiHandler>[1]): true {
  sendError(res, 404, 'not_found', 'not found');
  return true;
}

function conflict(res: Parameters<ApiHandler>[1], code: string): true {
  sendError(res, 409, code, 'conflict');
  return true;
}
