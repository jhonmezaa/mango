/**
 * Mock routes of Skills (D92): the catalog, one skill, a new skill or version and the decisions
 * on a request. In-memory state in the generated contract (packages/ts/api-client). Its
 * examples cover the states of the screen: a skill with a server that is not enabled, agents on
 * an earlier version, a new version and a new skill waiting for the mock user (another person
 * proposed them) and one of the mock user's own. One name and one text have HTML, to check they
 * render as text.
 *
 * Differences with the API, on purpose: the mock user is an administrator who can approve what
 * others propose; secrets are not looked for; the 30 days of activations are fixed numbers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

import { setDetailSkills } from './agents.ts';
import { MOCK_USER } from './cognito.ts';
import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';
import { catalogView } from './mcpCatalog.ts';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LIFETIME_MS = 72 * HOUR_MS;
const MAX_BODY_BYTES = 128 * 1024;
const CATEGORIES = ['FinOps', 'DevOps', 'ERP', 'Productivity', 'Security', 'Data'];
const OTHER = 'usuario3@empresa.com';
const APPROVER = 'usuario1@empresa.com';

interface Content {
  name: string;
  category: string;
  description: string;
  instructions: string;
  outputs: string[];
  servers: string[];
}

interface Version extends Content {
  version: number;
  proposed_by: string;
  approved_by: string;
  approved_at: string;
}

interface Change extends Content {
  change_id: string;
  skill_id: string;
  version: number;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
  reason: string;
  proposed_by: string;
  created_at: string;
  duplicate_of: string | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
}

interface MockSkill {
  id: string;
  versions: Version[];
  runs: number;
  /** Agents that use it, with the version they pin. */
  agents: { id: string; name: string; agent_version: number; skill_version: number }[];
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function versions(content: Content, count: number, proposer = OTHER): Version[] {
  return Array.from({ length: count }, (_, index) => ({
    ...content,
    version: index + 1,
    proposed_by: index % 2 ? 'usuario2@empresa.com' : proposer,
    approved_by: APPROVER,
    approved_at: ago((count - index) * 9 * DAY_MS),
  }));
}

const COST_REVIEW: Content = {
  name: 'Revisión de costos',
  category: 'FinOps',
  description: 'Resume el gasto del período por servicio y cuenta, y marca lo que más creció.',
  instructions:
    '1. Consulta el gasto de {{período}} en Cost Explorer, agrupado por servicio.\n2. Compara con el período anterior y marca lo que creció más de {{umbral}}.\n3. Entrega una tabla con servicio, gasto y variación.',
  outputs: ['tabla_resumen', 'variaciones'],
  servers: ['cost-explorer'],
};

const skills: MockSkill[] = [
  {
    id: 'revision-de-costos',
    versions: versions(COST_REVIEW, 3),
    runs: 1240,
    agents: [
      { id: 'agent-finops', name: 'FinOps', agent_version: 4, skill_version: 3 },
      { id: 'agent-savings', name: 'Savings Plans', agent_version: 2, skill_version: 2 },
    ],
  },
  {
    id: 'precios-de-instancias',
    versions: versions(
      {
        name: 'Precios de instancias',
        category: 'FinOps',
        description: 'Compara el precio de tipos de instancia en una región.',
        instructions:
          'Busca el precio por hora de {{tipos}} en {{región}} y ordénalos de menor a mayor.\nNo inventes precios: si un tipo no aparece, dilo.',
        outputs: [],
        servers: ['aws-pricing'],
      },
      1,
    ),
    runs: 0,
    agents: [],
  },
  {
    id: 'rightsizing-ec2',
    versions: versions(
      {
        name: 'Rightsizing <b>EC2</b>',
        category: 'DevOps',
        description: 'Propone tamaños de instancia según el uso. <img src=x onerror=alert(1)>',
        instructions:
          'Revisa las instancias de {{cuenta}} con uso bajo de CPU.\n<script>alert(1)</script>\nPropón un tamaño menor para cada una.',
        outputs: ['propuestas'],
        servers: ['ec2-operations', 'aws-pricing'],
      },
      2,
    ),
    runs: 87,
    agents: [],
  },
  {
    id: 'conciliacion-de-facturas',
    versions: versions(
      {
        name: 'Conciliación de facturas',
        category: 'ERP',
        description: 'Cruza las facturas de SAP con el gasto de Cost Explorer.',
        instructions:
          '1. Lista las facturas de {{período}} en SAP.\n2. Cruza cada una con el gasto de Cost Explorer.\n3. Marca diferencias mayores a {{tolerancia}}.',
        outputs: ['conciliación', 'diferencias'],
        servers: ['sap-s4-hana', 'cost-explorer'],
      },
      1,
    ),
    runs: 12,
    agents: [],
  },
];

const changes: Change[] = [
  {
    ...COST_REVIEW,
    instructions:
      '1. Consulta el gasto de {{período}} en Cost Explorer, agrupado por servicio y cuenta.\n2. Compara con el período anterior y marca lo que creció más de {{umbral}}.\n3. Entrega una tabla con servicio, cuenta, gasto y variación.\n4. Cierra con las tres acciones de mayor ahorro.',
    outputs: ['tabla_resumen', 'variaciones', 'acciones'],
    change_id: randomBytes(16).toString('hex'),
    skill_id: 'revision-de-costos',
    version: 4,
    status: 'pending',
    reason: 'Agrega la cuenta y las acciones de ahorro.',
    proposed_by: OTHER,
    created_at: ago(5 * HOUR_MS),
    duplicate_of: null,
    decided_by: null,
    decided_at: null,
    note: null,
  },
  {
    name: 'Salud de servicios',
    category: 'DevOps',
    description: 'Resume los eventos de AWS Health abiertos.',
    instructions: 'Lista los eventos abiertos de AWS Health en {{región}} y su impacto.',
    outputs: [],
    servers: ['aws-health'],
    change_id: randomBytes(16).toString('hex'),
    skill_id: 'salud-de-servicios',
    version: 1,
    status: 'pending',
    reason: 'La piden los equipos de operación.',
    proposed_by: OTHER,
    created_at: ago(26 * HOUR_MS),
    duplicate_of: null,
    decided_by: null,
    decided_at: null,
    note: null,
  },
  {
    name: 'Inventario de instancias',
    category: 'DevOps',
    description: 'Lista las instancias por cuenta y estado.',
    instructions: 'Lista las instancias de {{cuenta}} con su tipo y estado.',
    outputs: ['inventario'],
    servers: ['ec2-operations'],
    change_id: randomBytes(16).toString('hex'),
    skill_id: 'inventario-de-instancias',
    version: 1,
    status: 'pending',
    reason: 'Para el agente de operación.',
    proposed_by: MOCK_USER,
    created_at: ago(2 * HOUR_MS),
    duplicate_of: null,
    decided_by: null,
    decided_at: null,
    note: null,
  },
];

function servers() {
  return new Map(catalogView().items.map((server) => [server.id, server]));
}

type Catalog = ReturnType<typeof servers>;

function serverOut(id: string, catalog: Catalog) {
  const server = catalog.get(id);
  if (!server) return { id, name: null, enabled: false, data_tier: null, tools: 0, writes: false };
  return {
    id,
    name: server.name,
    enabled: server.enabled,
    data_tier: server.data_tier,
    tools: server.tools.length,
    writes: server.tools.some((tool) => tool.access !== 'read'),
  };
}

function variablesOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1] ?? ''))];
}

const RANK = { public: 0, account_data: 1, write: 2 } as const;

function expire(): void {
  const now = Date.now();
  for (const change of changes) {
    if (change.status === 'pending' && now - Date.parse(change.created_at) > LIFETIME_MS)
      change.status = 'expired';
  }
}

function changeOut(change: Change) {
  return {
    change_id: change.change_id,
    skill_id: change.skill_id,
    version: change.version,
    status: change.status,
    name: change.name,
    category: change.category,
    description: change.description,
    instructions: change.instructions,
    outputs: change.outputs,
    servers: change.servers,
    variables: variablesOf(change.instructions),
    reason: change.reason,
    proposed_by: change.proposed_by,
    proposed_by_email: change.proposed_by,
    created_at: change.created_at,
    expires_at: new Date(Date.parse(change.created_at) + LIFETIME_MS).toISOString(),
    duplicate_of: change.duplicate_of,
    decided_by: change.decided_by,
    decided_by_email: change.decided_by,
    decided_at: change.decided_at,
    note: change.note,
    own: change.proposed_by === MOCK_USER,
  };
}

function skillOut(skill: MockSkill, catalog: Catalog) {
  const latest = skill.versions[skill.versions.length - 1] as Version;
  const out = latest.servers.map((id) => serverOut(id, catalog));
  const tier = out.reduce<'public' | 'account_data' | 'write'>(
    (current, server) =>
      server.data_tier && RANK[server.data_tier] > RANK[current] ? server.data_tier : current,
    'public',
  );
  const pending = changes.find((c) => c.skill_id === skill.id && c.status === 'pending');
  return {
    id: skill.id,
    name: latest.name,
    category: latest.category,
    description: latest.description,
    version: latest.version,
    servers: out,
    data_tier: tier,
    writes: out.some((server) => server.writes),
    available: out.every((server) => server.enabled),
    agents: skill.agents.length,
    outdated_agents: skill.agents.filter((agent) => agent.skill_version < latest.version).length,
    runs_30d: skill.runs,
    owner: skill.versions[0]?.proposed_by ?? null,
    owner_email: skill.versions[0]?.proposed_by ?? null,
    updated_by: latest.proposed_by,
    updated_by_email: latest.proposed_by,
    updated_at: latest.approved_at,
    pending: pending ? changeOut(pending) : null,
  };
}

function listOut() {
  expire();
  const catalog = servers();
  const since = Date.now() - 30 * DAY_MS;
  return {
    items: skills.map((skill) => skillOut(skill, catalog)),
    changes: changes
      .filter((change) => Date.parse(change.created_at) >= since)
      .toSorted((a, b) => b.created_at.localeCompare(a.created_at))
      .map(changeOut),
    categories: CATEGORIES,
    max_per_agent: 10,
    can_approve: true,
  };
}

function detailOut(skill: MockSkill) {
  expire();
  const latest = skill.versions[skill.versions.length - 1] as Version;
  return {
    skill: skillOut(skill, servers()),
    instructions: latest.instructions,
    outputs: latest.outputs,
    variables: variablesOf(latest.instructions),
    agents_using: skill.agents,
    versions: skill.versions.map((version) => ({
      version: version.version,
      proposed_by: version.proposed_by,
      proposed_by_email: version.proposed_by,
      approved_by: version.approved_by,
      approved_by_email: version.approved_by,
      approved_at: version.approved_at,
      markdown_sha256: 'a'.repeat(64),
    })),
    changes: changes.filter((change) => change.skill_id === skill.id).map(changeOut),
  };
}

function idOf(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

const CONTENT_KEYS = [
  'name',
  'category',
  'description',
  'instructions',
  'outputs',
  'servers',
  'reason',
];

async function readContent(
  req: IncomingMessage,
  extra: string,
): Promise<(Content & { reason: string; extra: unknown }) | null> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}');
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const allowed = new Set([...CONTENT_KEYS, extra]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  const text = (key: string, max: number, min = 0) => {
    const value = record[key] ?? '';
    return typeof value === 'string' && value.trim().length >= min && value.length <= max
      ? value
      : null;
  };
  const list = (key: string) => {
    const value = record[key] ?? [];
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
  };
  const name = text('name', 48, 1);
  const description = text('description', 140);
  const instructions = text('instructions', 20_000, 1);
  const reason = text('reason', 500, 1);
  const outputs = list('outputs');
  const serverIds = list('servers');
  const category = text('category', 24);
  if (
    name === null ||
    description === null ||
    instructions === null ||
    reason === null ||
    outputs === null ||
    serverIds === null ||
    category === null ||
    !CATEGORIES.includes(category) ||
    outputs.length > 10 ||
    serverIds.length < 1 ||
    serverIds.length > 10
  )
    return null;
  return {
    name: name.trim(),
    category,
    description: description.trim(),
    instructions,
    outputs,
    servers: serverIds,
    reason: reason.trim(),
    extra: record[extra],
  };
}

function newChange(skillId: string, version: number, content: Content & { reason: string }) {
  const change: Change = {
    name: content.name,
    category: content.category,
    description: content.description,
    instructions: content.instructions,
    outputs: content.outputs,
    servers: content.servers,
    change_id: randomBytes(16).toString('hex'),
    skill_id: skillId,
    version,
    status: 'pending',
    reason: content.reason,
    proposed_by: MOCK_USER,
    created_at: new Date().toISOString(),
    duplicate_of: null,
    decided_by: null,
    decided_at: null,
    note: null,
  };
  return change;
}

function checkServers(res: ServerResponse, ids: string[]): boolean {
  const catalog = servers();
  const off = ids.filter((id) => !catalog.get(id)?.enabled);
  if (off.length) sendError(res, 422, 'server_not_enabled', 'an MCP server is not enabled');
  return off.length === 0;
}

/**
 * The rule of the API for the skills of an agent version (`agent_rules._skills`): every one is
 * an approved version, its servers are enabled and the version has a tool of each.
 */
/** `AgentOut.skills` of the detail (D95): name, description and version of the approved ones. */
export function versionSkills(refs: readonly string[]) {
  return refs.flatMap((ref) => {
    const [id = '', number = ''] = ref.split('@');
    const content = skills.find((skill) => skill.id === id)?.versions[Number(number) - 1];
    return content
      ? [{ id, version: Number(number), name: content.name, description: content.description }]
      : [];
  });
}

setDetailSkills(versionSkills);

export function skillViolations(definition: { skills: string[]; tools: string[] }) {
  const catalog = servers();
  const withTools = new Set(definition.tools.map((ref) => ref.split('.')[0]));
  const missing: string[] = [];
  const disabled: string[] = [];
  const withoutTools: string[] = [];
  for (const ref of definition.skills) {
    const [id, version] = ref.split('@');
    const content = skills.find((skill) => skill.id === id)?.versions[Number(version) - 1];
    if (!content) missing.push(ref);
    else if (!content.servers.every((server) => catalog.get(server)?.enabled)) disabled.push(ref);
    else if (!content.servers.every((server) => withTools.has(server))) withoutTools.push(ref);
  }
  const rules: [string, string[]][] = [
    ['skill_unavailable', missing],
    ['skill_server_not_enabled', disabled],
    ['skill_server_without_tools', withoutTools],
  ];
  return rules
    .filter(([, items]) => items.length > 0)
    .map(([code, items]) => ({ code, field: 'skills', items }));
}

const CHANGE_ROUTE = /^\/skills\/changes\/([0-9a-f]{32})\/(approve|reject|withdraw)$/;
const SKILL_ROUTE = /^\/skills\/([a-z0-9][a-z0-9-]{0,39})(\/versions)?$/;

export const handleSkills: ApiHandler = async (req, res, path) => {
  const { method } = req;
  if (path === '/skills') {
    if (method === 'GET') {
      sendJson(res, 200, listOut());
      return true;
    }
    if (method !== 'POST') return false;
    const content = await readContent(req, 'duplicate_of');
    if (!content) {
      sendError(res, 422, 'invalid_request', 'invalid fields');
      return true;
    }
    expire();
    const id = idOf(content.name);
    const open = (c: Change) => c.status === 'pending';
    if (
      !id ||
      skills.some((skill) => skill.id === id) ||
      changes.some((c) => c.skill_id === id && open(c))
    ) {
      sendError(res, 409, 'skill_exists', 'a skill with that name exists');
      return true;
    }
    if (changes.filter(open).length >= 20) {
      sendError(res, 409, 'too_many_pending', 'too many pending requests');
      return true;
    }
    if (!checkServers(res, content.servers)) return true;
    const change = newChange(id, 1, content);
    if (typeof content.extra === 'string') change.duplicate_of = content.extra;
    changes.unshift(change);
    sendJson(res, 201, { skill_id: id, change_id: change.change_id });
    return true;
  }
  const decision = CHANGE_ROUTE.exec(path);
  if (decision && method === 'POST') {
    const [, changeId, verb] = decision;
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      body = null;
    }
    expire();
    const change = changes.find((c) => c.change_id === changeId);
    if (!change) {
      sendError(res, 404, 'not_found', 'request not found');
      return true;
    }
    if (change.status === 'expired') {
      sendError(res, 410, 'expired', 'the request expired');
      return true;
    }
    if (change.status !== 'pending') {
      sendError(res, 409, 'version_conflict', 'the request is already closed');
      return true;
    }
    const own = change.proposed_by === MOCK_USER;
    if (verb === 'withdraw') {
      if (!own) {
        sendError(res, 403, 'not_proposer', 'only the proposer can withdraw this request');
        return true;
      }
      change.status = 'withdrawn';
    } else if (own) {
      sendError(
        res,
        403,
        verb === 'approve' ? 'same_approver' : 'use_withdraw',
        'another administrator must decide',
      );
      return true;
    } else if (verb === 'reject') {
      const note = (body as { reason?: unknown } | null)?.reason;
      if (typeof note !== 'string' || !note.trim()) {
        sendError(res, 422, 'invalid_request', 'invalid fields: reason');
        return true;
      }
      Object.assign(change, {
        status: 'rejected',
        note: note.trim(),
        decided_by: MOCK_USER,
        decided_at: new Date().toISOString(),
      });
    } else {
      Object.assign(change, {
        status: 'approved',
        decided_by: MOCK_USER,
        decided_at: new Date().toISOString(),
      });
      const version: Version = {
        name: change.name,
        category: change.category,
        description: change.description,
        instructions: change.instructions,
        outputs: change.outputs,
        servers: change.servers,
        version: change.version,
        proposed_by: change.proposed_by,
        approved_by: MOCK_USER,
        approved_at: new Date().toISOString(),
      };
      const skill = skills.find((item) => item.id === change.skill_id);
      if (skill) skill.versions.push(version);
      else skills.push({ id: change.skill_id, versions: [version], runs: 0, agents: [] });
    }
    sendJson(res, 200, listOut());
    return true;
  }
  const match = SKILL_ROUTE.exec(path);
  if (!match) return false;
  const [, skillId, sub] = match;
  const skill = skills.find((item) => item.id === skillId);
  if (!sub && method === 'GET') {
    if (!skill) sendError(res, 404, 'not_found', 'skill not found');
    else sendJson(res, 200, detailOut(skill));
    return true;
  }
  if (sub && method === 'POST') {
    const content = await readContent(req, 'base_version');
    if (!content) {
      sendError(res, 422, 'invalid_request', 'invalid fields');
      return true;
    }
    if (!skill) {
      sendError(res, 404, 'not_found', 'skill not found');
      return true;
    }
    expire();
    const latest = skill.versions.length;
    if (content.extra !== latest) {
      sendError(res, 409, 'version_conflict', 'the skill changed; reload and try again');
      return true;
    }
    if (changes.some((c) => c.skill_id === skill.id && c.status === 'pending')) {
      sendError(res, 409, 'already_pending', 'there is already an open request');
      return true;
    }
    if (!checkServers(res, content.servers)) return true;
    const change = newChange(skill.id, latest + 1, content);
    changes.unshift(change);
    sendJson(res, 201, { skill_id: skill.id, change_id: change.change_id });
    return true;
  }
  return false;
};
