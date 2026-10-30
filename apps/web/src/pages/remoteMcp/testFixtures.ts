// Fixtures of GET /api/mcp/remotes for the tests. Ids and URLs are placeholders.
import type { Registration, RemoteCatalog, RemoteProfile, RemoteRequest } from './model';

export const ME = 'user-me';
export const OTHER_ADMIN = 'user-other';
export const REG_ID = 'abcdefghij23';
export const REG_ID_2 = 'klmnopqrst45';
export const CHANGE = 'a'.repeat(32);
export const CHANGE_2 = 'b'.repeat(32);
export const CALLBACK =
  'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/00000000';
export const XSS = '<img src=x onerror=alert(1)>';

export const PROFILE: RemoteProfile = {
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
      tools: ['core_list_projects'],
      sensitivity: null,
      note: null,
      requirement: null,
    },
    {
      id: 'wit',
      label: 'Work items',
      always: false,
      tools: ['wit_work_item', 'wit_query'],
      sensitivity: null,
      note: null,
      requirement: null,
    },
    {
      id: 'wiki',
      label: 'Wiki',
      always: false,
      tools: ['wiki'],
      sensitivity: null,
      note: null,
      requirement: null,
    },
  ],
  enabled_in_installation: true,
};

/** Days from today as `YYYY-MM-DD` (local). */
export function inDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function request(patch: Partial<RemoteRequest> = {}): RemoteRequest {
  return {
    id: CHANGE,
    registration_id: REG_ID,
    kind: 'enable',
    status: 'pending',
    profile_id: PROFILE.id,
    profile_version: PROFILE.version,
    organization: 'contoso',
    toolsets: ['core', 'wit'],
    groups: ['finops-central'],
    previous_toolsets: null,
    previous_groups: null,
    tenant_id: '00000000-0000-4000-8000-000000000001',
    client_id: '00000000-0000-4000-8000-000000000002',
    callback_url: CALLBACK,
    secret_expires_on: inDays(180),
    reason: null,
    requested_by: OTHER_ADMIN,
    requested_by_email: 'otra@example.com',
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    expires_at: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    decision_reason: null,
    own: false,
    ...patch,
  };
}

export function registration(patch: Partial<Registration> = {}): Registration {
  return {
    id: REG_ID,
    profile_id: PROFILE.id,
    profile_in_release: true,
    organization: 'contoso',
    toolsets: ['core', 'wit'],
    groups: ['finops-central'],
    status: 'active',
    tools: ['core_list_projects', 'wit_query', 'wit_work_item'],
    secret_expires_on: inDays(120),
    secret_level: 'ok',
    disabled_by: null,
    disabled_at: null,
    reason: null,
    version: 4,
    tenant_id: '00000000-0000-4000-8000-000000000001',
    client_id: '00000000-0000-4000-8000-000000000002',
    callback_url: CALLBACK,
    requested_by: OTHER_ADMIN,
    requested_by_email: 'otra@example.com',
    approved_by: ME,
    approved_by_email: 'yo@example.com',
    approved_at: new Date(Date.now() - 19 * 86_400_000).toISOString(),
    failure_code: null,
    pending: null,
    history: [],
    ...patch,
  };
}

export function pendingRegistration(patch: Partial<RemoteRequest> = {}): Registration {
  return registration({
    status: 'pending',
    secret_expires_on: null,
    secret_level: null,
    approved_by: null,
    approved_by_email: null,
    approved_at: null,
    tools: [],
    version: 0,
    pending: request(patch),
  });
}

/** Toolsets with the marks a signed profile may carry (D98 (6), design round 27). */
export const MARKED_TOOLSETS: RemoteProfile['toolsets'] = [
  {
    id: 'repos',
    label: 'Repositorios',
    always: false,
    tools: ['repo_file'],
    sensitivity: 'source_code',
    note: 'El agente lee archivos, commits y pull requests de los repositorios.',
    requirement: null,
  },
  {
    id: 'search-code',
    label: 'Búsqueda de código',
    always: false,
    tools: ['search_code'],
    sensitivity: null,
    note: null,
    requirement: 'Necesita la extensión Code Search de Microsoft instalada en la organización.',
  },
];

export function remoteCatalog(
  registrations: Registration[] = [],
  profile: RemoteProfile = PROFILE,
): RemoteCatalog {
  return { enabled: true, profiles: [profile], registrations, max_registrations: 10 };
}

export function emptyRemoteCatalog(): RemoteCatalog {
  return remoteCatalog([]);
}
