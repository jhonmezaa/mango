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
  withdrawn_at?: string | null;
}

interface MockAgent {
  agent_id: string;
  name: string;
  groups_without_access: string[];
}

type DocumentStatus = 'uploaded' | 'indexing' | 'indexed' | 'failed' | 'deleting';

interface MockDoc {
  doc_id: string;
  name: string;
  size: number;
  content_type: string;
  status: DocumentStatus;
  reason: string | null;
  created_at: string;
  deleting_at: number | null;
}

/** A signed upload: its files and whether each one arrived at the "bucket". */
interface MockUpload {
  kb_id: string;
  expires: number;
  files: Map<string, { name: string; size: number; content_type: string; arrived: boolean }>;
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
  budget_by: { user_id: string; email: string | null; scheduled: boolean } | null;
  /** Until when a synchronization waits for the role of a source just approved (D88 (53)). */
  prepare_until: number | null;
  sources: MockSource[];
  agents: MockAgent[];
  deleting_at: number | null;
  sync_until: number | null;
  docs: MockDoc[];
}

const uploads = new Map<string, MockUpload>();
const UPLOAD_TTL_MS = 15 * MINUTE_MS;
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
};

/** Documents of an example: generic names, the size spread over them. */
function seedDocs(count: number, bytes: number, failed: [string, string][] = []): MockDoc[] {
  const docs: MockDoc[] = [];
  for (let i = 0; i < count; i += 1) {
    docs.push({
      doc_id: newId(),
      name: `documento-${String(i + 1).padStart(3, '0')}.pdf`,
      size: Math.max(1, Math.round(bytes / Math.max(1, count))),
      content_type: TYPES.pdf ?? '',
      status: 'indexed',
      reason: null,
      created_at: new Date(Date.now() - (i + 1) * HOUR_MS).toISOString(),
      deleting_at: null,
    });
  }
  for (const [name, reason] of failed) {
    docs.push({
      doc_id: newId(),
      name,
      size: 2_400_000,
      content_type: TYPES.pdf ?? '',
      status: 'failed',
      reason,
      created_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      deleting_at: null,
    });
  }
  return docs;
}

/** Keeps the counters of the list in step with the documents. */
function recount(kb: MockKb): void {
  const kept = kb.docs.filter((doc) => doc.status !== 'deleting');
  kb.documents = kept.length;
  kb.bytes = kept.reduce((sum, doc) => sum + doc.size, 0);
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
    budget_by: null,
    prepare_until: null,
    sources: [],
    agents: [],
    deleting_at: null,
    sync_until: null,
    ...extra,
    docs: extra.docs ?? seedDocs(extra.documents ?? 0, extra.bytes ?? 0),
  };
}

const kbs: MockKb[] = [
  base('Políticas de RH', {
    description: 'Vacaciones, beneficios y trabajo remoto',
    groups: ['finops-central', 'hr'],
    status: 'warn',
    documents: 9,
    bytes: 33_400_000,
    docs: seedDocs(8, 31_000_000, [['Formulario-escaneado.pdf', 'no_text']]),
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
    // The schedule stopped it, with the budget of its owner.
    budget_by: { user_id: OTHER.user_id, email: OTHER.email, scheduled: true },
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
      kb.budget_by = null;
      kb.prepare_until = null;
      kb.last_attempt_at = new Date().toISOString();
      kb.last_synced_at = kb.last_attempt_at;
      if (kb.origin === 'bucket' && !kb.docs.length) kb.docs = seedDocs(24, 26_000_000);
      for (const doc of kb.docs) {
        if (doc.status !== 'uploaded' && doc.status !== 'indexing') continue;
        // A scanned document has no text to index (design: «OCR sin texto legible»).
        const scanned = doc.name.toLowerCase().includes('escane');
        doc.status = scanned ? 'failed' : 'indexed';
        doc.reason = scanned ? 'no_text' : null;
      }
      if (kb.docs.some((doc) => doc.status === 'failed')) kb.status = 'warn';
      recount(kb);
    }
    const before = kb.docs.length;
    kb.docs = kb.docs.filter((doc) => doc.deleting_at === null || now < doc.deleting_at);
    if (kb.docs.length !== before) {
      recount(kb);
      if (!kb.docs.some((doc) => doc.status === 'failed') && kb.status === 'warn') kb.status = 'ok';
      if (!kb.docs.length && kb.origin === 'upload') kb.status = 'pending';
    }
  }
  for (const [id, upload] of uploads) if (now >= upload.expires) uploads.delete(id);
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
    budget_by: kb.budget_by,
    sync_preparing:
      kb.sync_until !== null && kb.prepare_until !== null && Date.now() < kb.prepare_until,
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
  /^\/knowledge-bases\/([0-9A-Z]{26})(?:\/(sync|delete|sources|documents|uploads|search)(?:\/([0-9A-Z]{26})\/(delete|approve|reject))?)?$/;
const S3_ROUTE = /^\/mock-s3\/([0-9A-Z]{26})\/([0-9A-Z]{26})$/;

/**
 * The "bucket" of the mock: takes the presigned POST of one file (`/mock-s3/{upload}/{doc}`).
 * Like S3 it needs no session; it only accepts a file it signed, within its size, before its
 * time is up.
 */
export async function handleMockS3(
  req: Parameters<ApiHandler>[0],
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  const match = S3_ROUTE.exec(path);
  if (!match || req.method !== 'POST') return false;
  const [, uploadId = '', docId = ''] = match;
  const file = uploads.get(uploadId)?.files.get(docId);
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 51 * 1024 * 1024) break;
  }
  if (!file || size > 51 * 1024 * 1024) {
    res.statusCode = 403;
    res.end();
    return true;
  }
  file.arrived = true;
  res.statusCode = 204;
  res.end();
  return true;
}

export const handleKnowledge: ApiHandler = async (req, res, path) => {
  const { method } = req;
  if (path === '/knowledge-sources' && method === 'GET') {
    settle();
    sendJson(res, 200, { items: queue() });
    return true;
  }
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
  const [, kbId, route, srcId, verb] = match;
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
  if (route === 'documents' && srcId === undefined) {
    if (method === 'GET') {
      sendJson(res, 200, { items: kb.docs.map(docView) });
      return true;
    }
    if (method === 'POST') return save(req, res, kb);
    return false;
  }
  if (route === 'documents' && srcId !== undefined && method === 'POST') {
    const input = await readObject(req, []);
    const doc = kb.docs.find((item) => item.doc_id === srcId);
    if (!input) return invalid(res);
    if (!doc) {
      sendError(res, 404, 'not_found', 'not found');
      return true;
    }
    if (doc.status === 'deleting') return conflict(res, 'document_deleting');
    doc.status = 'deleting';
    doc.deleting_at = Date.now() + DELETE_MS;
    recordAudit('kb.doc_remove', { kb: kb.kb_id, outcome: 'requested' });
    sendJson(res, 202, { document: docView(doc), sync: 'started' });
    return true;
  }
  if (route === 'uploads' && method === 'POST') return sign(req, res, kb);
  if (route === 'search' && method === 'POST') {
    const input = await readObject(req, ['query']);
    if (!input || typeof input.query !== 'string' || !input.query.trim()) return invalid(res);
    if (kb.status === 'deleting') return conflict(res, 'knowledge_base_deleting');
    const fragments = kb.docs
      .filter((doc) => doc.status === 'indexed')
      .slice(0, 3)
      .map((doc, index) => ({
        doc_id: doc.doc_id,
        document: doc.name,
        page: index === 1 ? null : index + 2,
        score: 0.58 - index * 0.05,
        text:
          index === 0
            ? 'Los días de vacaciones se acumulan desde el primer mes. <b>Texto</b> del documento, que se ve tal cual.'
            : `Fragmento ${String(index + 1)} de ${doc.name}.`,
      }));
    recordAudit('kb.search', { kb: kb.kb_id, fragments: fragments.length });
    sendJson(res, 200, { fragments });
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
  if (route === 'sources' && srcId !== undefined && verb !== 'delete' && method === 'POST') {
    return decide(req, res, kb, srcId, verb === 'approve');
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
    found.withdrawn_at = new Date().toISOString();
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

function docView(doc: MockDoc) {
  return {
    doc_id: doc.doc_id,
    name: doc.name,
    size: doc.size,
    content_type: doc.content_type,
    status: doc.status,
    reason: doc.reason,
    created_at: doc.created_at,
  };
}

/** POST …/uploads: one presigned "POST" per file, to the mock bucket of this origin. */
async function sign(
  req: Parameters<ApiHandler>[0],
  res: ServerResponse,
  kb: MockKb,
): Promise<true> {
  const input = await readObject(req, ['files']);
  const files = Array.isArray(input?.files) ? (input.files as unknown[]) : null;
  if (!files || files.length === 0 || files.length > 20) return invalid(res);
  if (kb.origin !== 'upload') return conflict(res, 'knowledge_base_origin');
  const upload: MockUpload = {
    kb_id: kb.kb_id,
    expires: Date.now() + UPLOAD_TTL_MS,
    files: new Map(),
  };
  let total = 0;
  for (const raw of files) {
    const file = raw as Record<string, unknown>;
    const name = typeof file.name === 'string' ? file.name : '';
    const size = typeof file.size === 'number' ? file.size : 0;
    const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
    const type = TYPES[ext];
    if (!type) {
      sendError(res, 422, 'type_not_supported', 'type not supported');
      return true;
    }
    if (file.content_type !== type) {
      sendError(res, 422, 'type_mismatch', 'the type is not its own');
      return true;
    }
    if (size < 1 || size > 50 * 1024 * 1024) return invalid(res);
    total += size;
    upload.files.set(newId(), { name, size, content_type: type, arrived: false });
  }
  if (kb.documents + files.length > 1000 || kb.bytes + total > 5 * 1024 ** 3)
    return conflict(res, 'knowledge_base_full');
  const uploadId = newId();
  uploads.set(uploadId, upload);
  const origin = `http://${req.headers.host ?? 'localhost:5173'}`;
  sendJson(res, 201, {
    upload_id: uploadId,
    expires_at: new Date(upload.expires).toISOString(),
    files: [...upload.files].map(([docId, file]) => ({
      doc_id: docId,
      name: file.name,
      url: `${origin}/mock-s3/${uploadId}/${docId}`,
      fields: { key: `uploads/${uploadId}/${docId}`, 'Content-Type': file.content_type },
    })),
  });
  return true;
}

/** POST …/documents: what arrived enters the knowledge base and starts indexing. */
async function save(
  req: Parameters<ApiHandler>[0],
  res: ServerResponse,
  kb: MockKb,
): Promise<true> {
  const input = await readObject(req, ['upload_id', 'doc_ids']);
  const upload = typeof input?.upload_id === 'string' ? uploads.get(input.upload_id) : undefined;
  const ids = Array.isArray(input?.doc_ids) ? (input.doc_ids as unknown[]) : null;
  if (!input || !ids || ids.length === 0) return invalid(res);
  if (!upload || upload.kb_id !== kb.kb_id) {
    sendError(res, 404, 'not_found', 'upload not found');
    return true;
  }
  const saved: MockDoc[] = [];
  const rejected: { doc_id: string; reason: string }[] = [];
  for (const id of ids) {
    const docId = String(id);
    const file = upload.files.get(docId);
    if (!file?.arrived) {
      rejected.push({ doc_id: docId, reason: 'not_uploaded' });
      continue;
    }
    // A file whose bytes are not of its type (design: «El contenido no es del tipo que dice»).
    if (file.name.toLowerCase().includes('falso')) {
      rejected.push({ doc_id: docId, reason: 'type_mismatch' });
      continue;
    }
    const doc: MockDoc = {
      doc_id: docId,
      name: file.name,
      size: file.size,
      content_type: file.content_type,
      status: 'indexing',
      reason: null,
      created_at: new Date().toISOString(),
      deleting_at: null,
    };
    kb.docs.unshift(doc);
    saved.push(doc);
    upload.files.delete(docId);
  }
  let sync: string | null = null;
  if (saved.length) {
    recount(kb);
    kb.status = 'syncing';
    kb.sync_until = Date.now() + SYNC_MS;
    sync = 'started';
    recordAudit('kb.documents_save', { kb: kb.kb_id, documents: saved.length, outcome: 'applied' });
  }
  sendJson(res, 200, { saved: saved.map(docView), rejected, sync });
  return true;
}

/**
 * The knowledge bases of a version as `mango_api.agents` gives them to the Builder and the
 * reviewer: name and status, or `null` when it no longer exists, and the groups of the agent that
 * are in none of its groups (D26, D88 (26)).
 */
export function knowledgeRefs(kbIds: readonly string[], agentGroups: readonly string[]) {
  settle();
  return kbIds.map((kbId) => {
    const kb = kbs.find((item) => item.kb_id === kbId);
    return {
      kb_id: kbId,
      name: kb ? kb.name : null,
      status: kb ? kb.status : null,
      groups_without_access: kb ? agentGroups.filter((group) => !kb.groups.includes(group)) : [],
    };
  });
}

/** A proposal as Aprobaciones and the Bandeja get it (`QueuedSourceOut`, D88 (48)). */
function queued(kb: MockKb, source: MockSource) {
  const approved = kb.sources.find((s) => s.status === 'approved' && s !== source);
  return {
    ...sourceView(kb, source),
    can_decide: source.status === 'pending' && source.proposed_by.user_id !== MOCK_USER,
    knowledge_base: kb.name,
    groups: kb.groups,
    sync_schedule: kb.sync_schedule,
    replaces:
      source.status === 'pending' && approved ? `s3://${approved.bucket}/${approved.prefix}` : null,
    withdrawn_at: source.withdrawn_at ?? null,
  };
}

/** GET /knowledge-sources: the mock user is an administrator, so every proposal is theirs to see. */
export function queue() {
  const live = kbs.filter((kb) => kb.status !== 'deleting');
  const pending = live.flatMap((kb) =>
    kb.sources.filter((s) => s.status === 'pending').map((s) => queued(kb, s)),
  );
  const decided = live.flatMap((kb) =>
    kb.sources
      .filter((s) => s.status === 'approved' || s.status === 'rejected' || s.status === 'withdrawn')
      .map((s) => queued(kb, s)),
  );
  return [
    ...pending.sort((a, b) => a.proposed_at.localeCompare(b.proposed_at)),
    ...decided.sort((a, b) =>
      (b.decided_at ?? b.withdrawn_at ?? '').localeCompare(a.decided_at ?? a.withdrawn_at ?? ''),
    ),
  ];
}

/** POST …/sources/{id}/approve|reject: a different administrator decides (D88 (20), (42)). */
async function decide(
  req: Parameters<ApiHandler>[0],
  res: ServerResponse,
  kb: MockKb,
  srcId: string,
  approve: boolean,
): Promise<true> {
  let input: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse((await readBody(req)) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    input = null;
  }
  const found = kb.sources.find((s) => s.src_id === srcId);
  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  if (!input || typeof input.version !== 'number') return invalid(res);
  if (!found) {
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  if (found.proposed_by.user_id === MOCK_USER) {
    sendError(res, 403, 'own_proposal', 'own proposal');
    return true;
  }
  if (input.version !== found.version) return conflict(res, 'version_conflict');
  if (found.status !== 'pending') return conflict(res, 'source_decided');
  if (!approve && !note) {
    sendError(res, 422, 'note_required', 'a rejection says why');
    return true;
  }
  const now = new Date().toISOString();
  if (approve) {
    for (const other of kb.sources) if (other.status === 'approved') other.status = 'removing';
    if (kb.status === 'pending') {
      // The new role takes a moment in IAM: «preparando el acceso» first (D88 (52), (53)).
      kb.prepare_until = Date.now() + SYNC_MS / 2;
      kb.sync_until = Date.now() + SYNC_MS;
      kb.status = 'syncing';
    }
  }
  found.status = approve ? 'approved' : 'rejected';
  found.decided_by = me;
  found.decided_at = now;
  found.note = note || null;
  found.version += 1;
  recordAudit(approve ? 'kb.source_approve' : 'kb.source_reject', {
    kb: kb.kb_id,
    note_chars: note.length,
    outcome: 'applied',
  });
  sendJson(res, 200, sourceView(kb, found));
  return true;
}
