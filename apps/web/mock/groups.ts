/**
 * Mock routes of Ajustes › Grupos: GET /admin/groups, POST /admin/groups/changes, the three
 * decisions of a request and PUT /admin/groups/{id}/description. In-memory state in the
 * generated contract (packages/ts/api-client). The mock user is an administrator: they approve
 * or reject what others proposed and only withdraw their own. It includes strings with HTML to
 * check they render as text.
 */
import { randomBytes } from 'node:crypto';

import { agents, publishedVersion } from './agents.ts';
import { auditedWrite } from './audit.ts';
import { MOCK_USER } from './cognito.ts';
import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';

type GroupType = 'central' | 'area' | 'general';
type Kind = 'create' | 'update' | 'delete';

interface MockGroup {
  id: string;
  type: GroupType;
  area: string | null;
  description: string;
  version: number;
}

interface MockGroupChange {
  change_id: string;
  kind: Kind;
  group_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  base_version: number;
  before: { type: GroupType; area: string | null } | null;
  after: { type: GroupType; area: string | null; description: string | null } | null;
  agents: number;
  proposed_by: string;
  proposed_by_email: string | null;
  reason: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  note: string | null;
}

const HOUR_MS = 3_600_000;
const CHANGE_TTL_MS = 72 * HOUR_MS;
const MAX_PENDING = 10;
const GROUP_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const NEW_GROUP_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;
const AREA_GROUP = /^bu-([a-z0-9-]{2,32})$/;
const ROLE_GROUPS = ['finops-central', 'bu-lead'];
const TYPES: readonly string[] = ['central', 'area', 'general'];
/** Areas of the mock mapping (`admin.ts`). */
const AREAS = ['finanzas', 'retail', 'plataforma'];
/** Groups of the mock user (the ones `GET /me` answers). */
const MOCK_USER_GROUPS = ['finops-central', 'mango-admin'];
/** An agent that uses account-data tools: it keeps its group central. */
const ACCOUNT_DATA_AGENTS: Record<string, { id: string; name: string }[]> = {
  'plataforma-sre': [{ id: 'k3fq7zr2m5xw6n4a', name: '<b>Alarmas</b> de plataforma' }],
};

const groups = new Map<string, MockGroup>(
  (
    [
      { id: 'bu-finanzas', type: 'area', area: 'finanzas', description: 'Líderes de Finanzas' },
      { id: 'bu-lead', type: 'general', area: null, description: 'Líderes de área' },
      { id: 'bu-retail', type: 'area', area: 'retail', description: 'Líderes de Retail' },
      { id: 'finops-central', type: 'central', area: null, description: 'FinOps central' },
      {
        id: 'plataforma-sre',
        type: 'central',
        area: null,
        description: '<img src=x onerror=alert(1)> Plataforma y SRE',
      },
      { id: 'seguridad', type: 'central', area: null, description: 'Seguridad central' },
      {
        id: 'toda-la-empresa',
        type: 'general',
        area: null,
        description: 'Toda la organización',
      },
    ] satisfies Omit<MockGroup, 'version'>[]
  ).map((group) => [group.id, { ...group, version: 0 }]),
);

function seed(
  hoursAgo: number,
  change: Pick<MockGroupChange, 'kind' | 'group_id' | 'reason'> & Partial<MockGroupChange>,
): MockGroupChange {
  const created = Date.now() - hoursAgo * HOUR_MS;
  return {
    change_id: randomBytes(16).toString('hex'),
    status: 'pending',
    base_version: 0,
    before: null,
    after: null,
    agents: 0,
    proposed_by: 'admin-2',
    proposed_by_email: 'otra.admin@example.com',
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + CHANGE_TTL_MS).toISOString(),
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    note: null,
    ...change,
  };
}

/** Newest first, like the API. */
const changes: MockGroupChange[] = [
  seed(0.5, {
    kind: 'create',
    group_id: 'legal',
    after: { type: 'general', area: null, description: 'Equipo legal' },
    proposed_by: MOCK_USER,
    proposed_by_email: MOCK_USER,
    reason: 'El equipo legal va a usar un agente de contratos.',
  }),
  seed(3, {
    kind: 'create',
    group_id: 'finanzas-lideres',
    after: { type: 'area', area: 'finanzas', description: 'Líderes de Finanzas (LATAM)' },
    reason: '<script>alert(1)</script> Nuevo equipo regional.',
  }),
  seed(5, {
    kind: 'update',
    group_id: 'seguridad',
    before: { type: 'central', area: null },
    after: { type: 'general', area: null, description: null },
    reason: 'Seguridad ya no consulta datos de cuentas.',
  }),
  seed(80, {
    kind: 'delete',
    group_id: 'toda-la-empresa',
    before: { type: 'general', area: null },
    reason: 'Se reemplaza por grupos por equipo.',
  }),
  seed(120, {
    kind: 'update',
    group_id: 'bu-retail',
    status: 'rejected',
    before: { type: 'area', area: 'retail' },
    after: { type: 'central', area: null, description: null },
    proposed_by: MOCK_USER,
    proposed_by_email: MOCK_USER,
    reason: 'Retail necesita ver todas las cuentas.',
    decided_by: 'admin-3',
    decided_by_email: '<b>seguridad</b>@example.com',
    decided_at: new Date(Date.now() - 100 * HOUR_MS).toISOString(),
    note: 'Un grupo de área no puede ser central.',
  }),
];

function shownStatus(change: MockGroupChange): string {
  return change.status === 'pending' && Date.parse(change.expires_at) <= Date.now()
    ? 'expired'
    : change.status;
}

function isOpen(change: MockGroupChange): boolean {
  return shownStatus(change) === 'pending';
}

function agentsUsing(groupId: string) {
  const published = [...agents.values()].flatMap((agent) => {
    const version = publishedVersion(agent);
    return version?.definition.groups.includes(groupId)
      ? [{ id: agent.agent_id, name: version.definition.name, account_data: false }]
      : [];
  });
  const accountData = (ACCOUNT_DATA_AGENTS[groupId] ?? []).map((agent) => ({
    ...agent,
    account_data: true,
  }));
  return [...accountData, ...published].sort((a, b) => a.name.localeCompare(b.name));
}

function fixedShape(groupId: string): { type: GroupType; area: string | null } | null {
  if (groupId === 'finops-central') return { type: 'central', area: null };
  if (groupId === 'bu-lead') return { type: 'general', area: null };
  const area = AREA_GROUP.exec(groupId)?.[1];
  return area ? { type: 'area', area } : null;
}

function view() {
  return {
    items: [...groups.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((group) => ({
        id: group.id,
        type: group.type,
        area: group.area,
        description: group.description,
        version: group.version,
        system: ROLE_GROUPS.includes(group.id),
        fixed_type: fixedShape(group.id) !== null,
        agents: agentsUsing(group.id),
      })),
    changes: changes.map((change) => {
      // `base_version` is internal: the contract does not expose it.
      const out: Partial<MockGroupChange> = { ...change };
      delete out.base_version;
      return { ...out, status: shownStatus(change) };
    }),
  };
}

async function readJson(
  req: Parameters<ApiHandler>[0],
  allowed: readonly string[],
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  // extra="forbid": unknown fields are refused.
  return Object.keys(record).every((key) => allowed.includes(key)) ? record : null;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

type Refusal = [status: number, code: string];

function shapeRefusal(
  kind: Kind,
  groupId: string,
  type: GroupType,
  area: string | null,
  current: MockGroup | undefined,
): Refusal | null {
  const fixed = fixedShape(groupId);
  if (fixed && (fixed.type !== type || fixed.area !== area)) return [422, 'fixed_type'];
  if (area !== null && !AREAS.includes(area)) return [422, 'unknown_area'];
  if (kind !== 'update' || !current) return null;
  if (current.type === type && current.area === area) return [422, 'invalid_request'];
  const holding = agentsUsing(groupId).some((agent) => agent.account_data);
  return current.type === 'central' && type !== 'central' && holding
    ? [409, 'central_in_use']
    : null;
}

function proposalRefusal(body: Record<string, unknown>): Refusal | MockGroupChange {
  const kind = text(body.kind) as Kind | null;
  const groupId = text(body.group_id) ?? '';
  const reason = (text(body.reason) ?? '').trim();
  const type = body.type === undefined ? null : text(body.type);
  const area = text(body.area ?? null);
  const description = body.description === undefined ? null : text(body.description);
  const baseVersion = typeof body.base_version === 'number' ? body.base_version : null;
  const invalid: Refusal = [422, 'invalid_request'];
  if (!kind || !['create', 'update', 'delete'].includes(kind)) return invalid;
  if (!GROUP_ID.test(groupId) || !reason || reason.length > 500) return invalid;
  if ((kind === 'create') !== (baseVersion === null)) return invalid;
  if (kind === 'delete' ? type !== null || area !== null : !type || !TYPES.includes(type)) {
    return invalid;
  }
  if (kind !== 'delete' && (type === 'area') !== (area !== null)) return invalid;
  if ((description ?? '').length > 200) return invalid;
  if (groupId.startsWith('mango-')) return [422, 'reserved_name'];
  if (kind === 'create' && !NEW_GROUP_ID.test(groupId)) return invalid;

  const current = groups.get(groupId);
  if (kind !== 'delete' && MOCK_USER_GROUPS.includes(groupId)) return [403, 'self_edit'];
  if (kind === 'create' && current) return [409, 'group_exists'];
  if (kind !== 'create' && !current) return [404, 'not_found'];
  if (current && current.version !== baseVersion) return [409, 'version_conflict'];
  if (kind === 'delete' && ROLE_GROUPS.includes(groupId)) return [422, 'system_group'];
  if (kind !== 'delete') {
    const refusal = shapeRefusal(kind, groupId, type as GroupType, area, current);
    if (refusal) return refusal;
  }
  if (changes.some((change) => change.group_id === groupId && isOpen(change))) {
    return [409, 'already_pending'];
  }
  if (changes.filter(isOpen).length >= MAX_PENDING) return [409, 'too_many_pending'];
  return seed(0, {
    kind,
    group_id: groupId,
    base_version: baseVersion ?? 0,
    before: current ? { type: current.type, area: current.area } : null,
    after:
      kind === 'delete'
        ? null
        : {
            type: type as GroupType,
            area,
            description: kind === 'create' ? (description ?? '') : description,
          },
    agents: agentsUsing(groupId).length,
    proposed_by: MOCK_USER,
    proposed_by_email: MOCK_USER,
    reason,
  });
}

function apply(change: MockGroupChange): void {
  if (change.kind === 'delete') {
    groups.delete(change.group_id);
    return;
  }
  const after = change.after;
  if (!after) return;
  const current = groups.get(change.group_id);
  groups.set(change.group_id, {
    id: change.group_id,
    type: after.type,
    area: after.area,
    description: after.description ?? current?.description ?? '',
    version: (current?.version ?? 0) + 1,
  });
}

const CHANGE_ROUTE = /^\/admin\/groups\/changes\/([0-9a-f]{32})\/(approve|reject|withdraw)$/;
const DESCRIPTION_ROUTE = /^\/admin\/groups\/([a-z0-9][a-z0-9-]{1,63})\/description$/;

export const handleGroups: ApiHandler = async (req, res, path) => {
  if (!path.startsWith('/admin/groups')) return false;
  const refuse = ([status, code]: Refusal) => {
    sendError(res, status, code, 'Refused by the mock');
    return true;
  };
  if (path === '/admin/groups' && req.method === 'GET') {
    sendJson(res, 200, view());
    return true;
  }
  if (path === '/admin/groups/changes' && req.method === 'POST') {
    const body = await readJson(req, [
      'kind',
      'group_id',
      'type',
      'area',
      'description',
      'base_version',
      'reason',
    ]);
    if (!body) return refuse([422, 'invalid_request']);
    const result = proposalRefusal(body);
    if (Array.isArray(result)) return refuse(result);
    auditedWrite(
      'settings.groups.proposed',
      { change_id: result.change_id, kind: result.kind, group: result.group_id },
      () => {
        changes.unshift(result);
      },
    );
    sendJson(res, 201, { change_id: result.change_id });
    return true;
  }
  const description = DESCRIPTION_ROUTE.exec(path);
  if (description && req.method === 'PUT') {
    const body = await readJson(req, ['version', 'description']);
    const value = text(body?.description);
    if (!body || value === null || value.length > 200) return refuse([422, 'invalid_request']);
    const group = groups.get(description[1] ?? '');
    if (!group) return refuse([404, 'not_found']);
    if (group.version !== body.version) return refuse([409, 'version_conflict']);
    if (changes.some((change) => change.group_id === group.id && isOpen(change))) {
      return refuse([409, 'already_pending']);
    }
    auditedWrite('settings.groups.description_updated', { group: group.id }, () => {
      group.description = value;
      group.version += 1;
    });
    sendJson(res, 200, view());
    return true;
  }
  const match = CHANGE_ROUTE.exec(path);
  if (!match || req.method !== 'POST') return false;
  const [, changeId, action] = match;
  const body = await readJson(req, action === 'reject' ? ['reason'] : []);
  const note = (text(body?.reason) ?? '').trim();
  if (!body || (action === 'reject' && !note)) return refuse([422, 'invalid_request']);
  const change = changes.find((item) => item.change_id === changeId);
  if (!change) return refuse([404, 'not_found']);
  if (change.status !== 'pending') return refuse([409, 'version_conflict']);
  const mine = change.proposed_by === MOCK_USER;
  if (action === 'withdraw' && !mine) return refuse([403, 'not_proposer']);
  if (action === 'approve' && !isOpen(change)) return refuse([410, 'expired']);
  if (action === 'approve' && mine) return refuse([403, 'same_approver']);
  if (action === 'reject' && mine) return refuse([403, 'use_withdraw']);
  if (action !== 'withdraw' && change.kind !== 'delete') {
    if (MOCK_USER_GROUPS.includes(change.group_id)) return refuse([403, 'self_edit']);
  }
  if (action === 'approve') {
    const current = groups.get(change.group_id);
    if ((change.kind === 'create') === Boolean(current)) return refuse([409, 'version_conflict']);
    if (current && current.version !== change.base_version) {
      return refuse([409, 'version_conflict']);
    }
  }
  const status = { approve: 'approved', reject: 'rejected', withdraw: 'withdrawn' } as const;
  const event = `settings.groups.${status[action as keyof typeof status]}`;
  auditedWrite(event, { change_id: change.change_id, group: change.group_id }, () => {
    if (action === 'approve') apply(change);
    Object.assign(change, {
      status: status[action as keyof typeof status],
      decided_by: MOCK_USER,
      decided_by_email: action === 'withdraw' ? null : MOCK_USER,
      decided_at: new Date().toISOString(),
      note: action === 'reject' ? note : null,
    });
  });
  sendJson(res, 200, view());
  return true;
};
