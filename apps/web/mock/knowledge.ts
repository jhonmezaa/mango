/**
 * Mock routes of Knowledge Bases (D88): the list, one knowledge base, create, edit, delete,
 * «Sincronizar ahora» and the bucket sources (propose and withdraw). In-memory state in the
 * generated contract (packages/ts/api-client). Its examples cover the states of the screen, and
 * one name has HTML to check it renders as text.
 *
 * Differences with the API, on purpose: the "synchronization" finishes by itself a few seconds
 * after it starts, and the bucket checks only look at the name (`mango-…` is Mango's; a name
 * with `otra-cuenta` is of another account). The mock has one user, so a proposal of their own
 * can never be approved here.
 */
import type { ServerResponse } from 'node:http';

import { recordAudit } from './audit.ts';
import { MOCK_USER } from './cognito.ts';
import { newId, readBody, readObject, sendError, sendJson, type ApiHandler } from './http.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** How long the mock synchronization and deletion take. */
const SYNC_MS = 4000;
const DELETE_MS = 5000;
const OTHER = { user_id: 'usuario3@example.com', email: 'usuario3@example.com' };
const ADMIN = { user_id: 'otra.admin@example.com', email: 'otra.admin@example.com' };

type Status = 'pending' | 'syncing' | 'ok' | 'warn' | 'error' | 'deleting';
type SourceStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'removing';
type Schedule = 'manual' | '6h' | 'daily' | 'weekly';

interface Person {
  user_id: string;
  email: string | null;
}

interface MockSource {
  src_id: string;
  bucket: string;
  prefix: string;
  status: SourceStatus;
  proposed_by: Person;
  proposed_at: string;
  decided_by: Person | null;
  decided_at: string | null;
  note: string | null;
  version: number;
}

interface MockAgent {
  agent_id: string;
  name: string;
  groups_without_access: string[];
}

interface MockKb {
  kb_id: string;
  name: string;
  description: string;
  origin: 'upload' | 'bucket';
  owner: Person & { name: string | null };
  groups: string[];
  status: Status;
  sync_schedule: Schedule;
  documents: number;
  bytes: number;
  version: number;
  created_at: string;
  updated_at: string;
  last_attempt_at: string | null;
  last_synced_at: string | null;
  status_reason: 'budget' | 'error' | 'full' | null;
  budget_estimate_usd: string | null;
  sources: MockSource[];
  agents: MockAgent[];
  deleting_at: number | null;
  sync_until: number | null;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const me = { user_id: MOCK_USER, email: MOCK_USER, name: 'Usuario 1' };

function source(
  bucket: string,
  prefix: string,
  status: SourceStatus,
  extra: Partial<MockSource> = {},
): MockSource {
  const decided = status === 'approved' || status === 'rejected';
  return {
    src_id: newId(),
    bucket,
    prefix,
    status,
    proposed_by: me,
    proposed_at: ago(30 * HOUR_MS),
    decided_by: decided ? ADMIN : null,
    decided_at: decided ? ago(29 * HOUR_MS) : null,
    note: null,
    version: decided ? 2 : 1,
    ...extra,
  };
}

function base(name: string, extra: Partial<MockKb>): MockKb {
  return {
    kb_id: newId(),
    name,
    description: '',
    origin: 'upload',
    owner: me,
    groups: ['finops-central'],
    status: 'ok',
    sync_schedule: 'daily',
    documents: 0,
    bytes: 0,
    version: 1,
    created_at: ago(72 * HOUR_MS),
    updated_at: ago(24 * HOUR_MS),
    last_attempt_at: ago(3 * HOUR_MS),
    last_synced_at: ago(3 * HOUR_MS),
    status_reason: null,
    budget_estimate_usd: null,
    sources: [],
    agents: [],
    deleting_at: null,
    sync_until: null,
    ...extra,
  };
}

const kbs: MockKb[] = [
  base('Políticas de RH', {
    description: 'Vacaciones, beneficios y trabajo remoto',
    groups: ['finops-central', 'hr'],
    documents: 8,
    bytes: 31_000_000,
    agents: [
      { agent_id: 'peopledocs000001', name: 'People Docs', groups_without_access: ['mango-admin'] },
    ],
  }),
  base('AWS Runbooks', {
    description: 'Procedimientos de operación',
    origin: 'bucket',
    documents: 142,
    bytes: 410_000_000,
    sources: [
      source('empresa-runbooks', 'ops/', 'approved'),
      source('empresa-runbooks', 'ops-2026/', 'pending', { proposed_by: OTHER }),
    ],
  }),
  base('Security Baseline', {
    description: 'Controles y respuesta a incidentes',
    origin: 'bucket',
    status: 'pending',
    last_attempt_at: null,
    last_synced_at: null,
    sources: [source('empresa-seguridad', 'baseline/', 'pending', { proposed_by: OTHER })],
  }),
  base('Etiquetado de costos', {
    description: 'Reglas de etiquetas y asignación',
    origin: 'bucket',
    status: 'pending',
    status_reason: 'budget',
    budget_estimate_usd: '12.40',
    last_synced_at: null,
    sources: [source('empresa-finops', 'etiquetas/', 'approved')],
  }),
  base('Release Archive', {
    description: 'Notas de versión y RFC',
    origin: 'bucket',
    status: 'ok',
    status_reason: 'full',
    documents: 1000,
    bytes: 2_100_000_000,
    sources: [source('empresa-releases', '', 'approved')],
  }),
  base('Customer Docs', {
    description: 'Documentación pública',
    origin: 'bucket',
    status: 'pending',
    last_attempt_at: null,
    last_synced_at: null,
    sources: [
      source('empresa-sitio', 'docs/', 'rejected', {
        note: 'Es la documentación del sitio público: los agentes no necesitan una copia.',
      }),
    ],
  }),
  base('<b>Manual</b> <img src=x onerror=alert(1)>', {
    description: 'Un nombre con HTML, que se ve como texto',
    status: 'pending',
    last_attempt_at: null,
    last_synced_at: null,
  }),
];

/** Advances the synchronizations and deletions that finished. */
function settle(): void {
  const now = Date.now();
  for (const kb of kbs) {
    if (kb.sync_until !== null && now >= kb.sync_until) {
      kb.sync_until = null;
      kb.status = 'ok';
      kb.status_reason = null;
      kb.budget_estimate_usd = null;
      kb.last_attempt_at = new Date().toISOString();
      kb.last_synced_at = kb.last_attempt_at;
      if (!kb.documents) {
        kb.documents = 24;
        kb.bytes = 26_000_000;
      }
    }
  }
  for (let i = kbs.length - 1; i >= 0; i -= 1) {
    const kb = kbs[i];
    if (kb?.deleting_at !== null && kb?.deleting_at !== undefined && now >= kb.deleting_at)
      kbs.splice(i, 1);
  }
}

function view(kb: MockKb) {
  const active = kb.sources.filter((s) => s.status === 'approved' || s.status === 'pending');
  const decided = kb.sources.filter((s) => s.status === 'rejected' || s.status === 'withdrawn');
  const shown = active.some((s) => s.status === 'pending')
    ? active
    : [...active, ...decided.slice(-1)];
  return {
    kb_id: kb.kb_id,
    name: kb.name,
    description: kb.description,
    origin: kb.origin,
    owner: kb.owner,
    groups: kb.groups,
    status: kb.status,
    sync_schedule: kb.sync_schedule,
    documents: kb.documents,
    bytes: kb.bytes,
    version: kb.version,
    created_at: kb.created_at,
    updated_at: kb.updated_at,
    last_attempt_at: kb.last_attempt_at,
    last_synced_at: kb.last_synced_at,
    status_reason: kb.status_reason,
    budget_estimate_usd: kb.budget_estimate_usd,
    agents: kb.agents,
    business_unit: 'shared',
    classification: 'internal',
    sync_running: kb.sync_until !== null,
    can_edit: true,
    can_view_documents: true,
    can_search: kb.groups.includes('finops-central') || kb.groups.includes('mango-admin'),
    sources:
      kb.origin === 'bucket'
        ? shown.map((s) => ({
            src_id: s.src_id,
            status: s.status,
            location: `s3://${s.bucket}/${s.prefix}`,
          }))
        : [],
  };
}

function sourceView(kb: MockKb, s: MockSource) {
  return { ...s, kb_id: kb.kb_id, role_ready: s.status === 'approved', can_decide: false };
}

function invalid(res: ServerResponse): true {
  sendError(res, 422, 'invalid_request', 'invalid request');
  return true;
}

function conflict(res: ServerResponse, code: string): true {
  sendError(res, 409, code, code);
  return true;
}

const SCHEDULES = new Set(['manual', '6h', 'daily', 'weekly']);

/** A JSON object with `required` keys and maybe some of `optional` (extra="forbid"). */
async function readFields(
  req: Parameters<ApiHandler>[0],
  required: string[],
  optional: string[],
): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in record) && keys.every((key) => allowed.has(key))
    ? record
    : null;
}

function scheduleOf(value: unknown, fallback: Schedule): Schedule | null {
  if (value === undefined) return fallback;
  return typeof value === 'string' && SCHEDULES.has(value) ? (value as Schedule) : null;
}
const LOCATION = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/?(\S*)$/;

function groupsOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const groups = value.filter(
    (g): g is string => typeof g === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(g),
  );
  return groups.length === value.length && new Set(groups).size === groups.length ? groups : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/** The bucket checks of the API, by name only. */
function refused(bucket: string): string | null {
  if (bucket.startsWith('mango-')) return 'mango_bucket';
  if (bucket.includes('otra-cuenta')) return 'bucket_not_in_account';
  return null;
}

async function propose(
  req: Parameters<ApiHandler>[0],
  res: ServerResponse,
  kb: MockKb,
): Promise<true> {
  const input = await readObject(req, ['location']);
  const match = typeof input?.location === 'string' ? LOCATION.exec(input.location.trim()) : null;
  if (!match) return invalid(res);
  const [, bucket = '', prefix = ''] = match;
  if (kb.origin !== 'bucket') return conflict(res, 'knowledge_base_origin');
  if (kb.sources.some((s) => s.status === 'pending')) return conflict(res, 'source_pending');
  const code = refused(bucket);
  if (code) {
    sendError(res, 422, code, code);
    return true;
  }
  const created = source(bucket, prefix, 'pending');
  created.proposed_at = new Date().toISOString();
  kb.sources.push(created);
  recordAudit('kb.source_propose', { kb: kb.kb_id, bucket, outcome: 'requested' });
  sendJson(res, 201, sourceView(kb, created));
  return true;
}

const KB_ROUTE =
  /^\/knowledge-bases\/([0-9A-Z]{26})(?:\/(sync|delete|sources)(?:\/([0-9A-Z]{26})\/delete)?)?$/;

export const handleKnowledge: ApiHandler = async (req, res, path) => {
  const { method } = req;
  if (path === '/knowledge-bases') {
    settle();
    if (method === 'GET') {
      sendJson(res, 200, { items: kbs.map(view), can_create: true });
      return true;
    }
    if (method !== 'POST') return false;
    return create(
      await readFields(
        req,
        ['name', 'origin', 'groups'],
        ['description', 'sync_schedule', 'classification', 'business_unit'],
      ),
      res,
    );
  }
  const match = KB_ROUTE.exec(path);
  if (!match) return false;
  settle();
  const [, kbId, route, srcId] = match;
  const kb = kbs.find((item) => item.kb_id === kbId);
  if (!kb) {
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  if (route === undefined) {
    if (method === 'GET') {
      sendJson(res, 200, view(kb));
      return true;
    }
    if (method !== 'PUT') return false;
    const input = await readFields(
      req,
      ['version', 'name', 'groups'],
      ['description', 'sync_schedule', 'classification'],
    );
    const groups = groupsOf(input?.groups);
    const schedule = scheduleOf(input?.sync_schedule, kb.sync_schedule);
    if (!input || !groups || !schedule || typeof input.version !== 'number') return invalid(res);
    if (input.version !== kb.version) return conflict(res, 'version_conflict');
    kb.groups = groups;
    kb.sync_schedule = schedule;
    kb.version += 1;
    kb.updated_at = new Date().toISOString();
    recordAudit('kb.update', { kb: kb.kb_id, groups, outcome: 'applied' });
    sendJson(res, 200, view(kb));
    return true;
  }
  if (route === 'sync' && method === 'POST') {
    if (kb.status === 'deleting') return conflict(res, 'knowledge_base_deleting');
    if (kb.sync_until !== null) {
      sendJson(res, 202, { sync: 'queued' });
      return true;
    }
    kb.sync_until = Date.now() + SYNC_MS;
    kb.status = 'syncing';
    recordAudit('kb.sync', { kb: kb.kb_id, outcome: 'requested' });
    sendJson(res, 202, { sync: 'started' });
    return true;
  }
  if (route === 'delete' && method === 'POST') {
    const input = await readObject(req, ['version']);
    if (!input || typeof input.version !== 'number') return invalid(res);
    if (input.version !== kb.version) return conflict(res, 'version_conflict');
    if (kb.agents.length) return conflict(res, 'knowledge_base_in_use');
    kb.status = 'deleting';
    kb.deleting_at = Date.now() + DELETE_MS;
    kb.version += 1;
    recordAudit('kb.delete', { kb: kb.kb_id, outcome: 'requested' });
    sendJson(res, 202, view(kb));
    return true;
  }
  if (route === 'sources' && srcId === undefined) {
    if (method === 'GET') {
      sendJson(res, 200, { items: kb.sources.map((s) => sourceView(kb, s)) });
      return true;
    }
    if (method === 'POST') return propose(req, res, kb);
    return false;
  }
  if (route === 'sources' && srcId !== undefined && method === 'POST') {
    const input = await readObject(req, ['version']);
    const found = kb.sources.find((s) => s.src_id === srcId);
    if (!input || typeof input.version !== 'number') return invalid(res);
    if (!found) {
      sendError(res, 404, 'not_found', 'not found');
      return true;
    }
    if (input.version !== found.version) return conflict(res, 'version_conflict');
    if (found.status !== 'pending') return conflict(res, 'source_decided');
    found.status = 'withdrawn';
    found.decided_at = new Date().toISOString();
    found.version += 1;
    recordAudit('kb.source_withdraw', { kb: kb.kb_id, outcome: 'applied' });
    sendJson(res, 202, sourceView(kb, found));
    return true;
  }
  return false;
};

function create(input: Record<string, unknown> | null, res: ServerResponse): true {
  if (!input) return invalid(res);
  const name = text(input.name, 120)?.trim();
  const description = text(input.description, 500) ?? '';
  const groups = groupsOf(input.groups);
  const origin = input.origin === 'bucket' ? 'bucket' : input.origin === 'upload' ? 'upload' : null;
  const schedule = scheduleOf(input.sync_schedule, 'daily');
  if (!name || !groups || !origin || !schedule) return invalid(res);
  const kb = base(name, {
    description: description.trim(),
    origin,
    groups,
    status: 'pending',
    sync_schedule: schedule,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_attempt_at: null,
    last_synced_at: null,
  });
  kbs.push(kb);
  recordAudit('kb.create', { kb: kb.kb_id, origin, outcome: 'applied' });
  sendJson(res, 201, view(kb));
  return true;
}
