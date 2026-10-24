import { baseMe } from '../../test/fixtures';
import type { KnowledgeBase, KnowledgeList, Source } from './model';

export const KB_ID = '01JC0000000000000000000001';
export const OTHER_KB = '01JC0000000000000000000002';
export const SRC_ID = '01JD0000000000000000000001';
export const ADMIN_ID = 'a1b2c3d4-0000-4000-8000-0000000000ff';
/** Text that would be markup if it were ever rendered as HTML. */
export const XSS = '<img src=x onerror=alert(1)>';

export function kb(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    kb_id: KB_ID,
    name: 'Políticas de RH',
    description: 'Vacaciones y beneficios',
    origin: 'upload',
    owner: { user_id: baseMe.user_id, email: baseMe.email ?? null, name: null },
    groups: ['finops-central'],
    business_unit: 'shared',
    classification: 'internal',
    status: 'ok',
    sync_running: false,
    sync_schedule: 'daily',
    documents: 12,
    bytes: 48_000_000,
    version: 3,
    can_edit: true,
    can_view_documents: true,
    can_search: true,
    created_at: '2026-10-20T10:00:00Z',
    updated_at: '2026-10-21T10:00:00Z',
    last_attempt_at: '2026-10-21T10:00:00Z',
    last_synced_at: '2026-10-21T10:00:00Z',
    status_reason: null,
    budget_estimate_usd: null,
    budget_by: null,
    sync_preparing: false,
    sources: [],
    agents: [],
    ...overrides,
  };
}

export function bucketKb(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return kb({
    kb_id: OTHER_KB,
    name: 'AWS Runbooks',
    description: 'Procedimientos de operación',
    origin: 'bucket',
    sources: [{ src_id: SRC_ID, status: 'approved', location: 's3://empresa-runbooks/ops/' }],
    ...overrides,
  });
}

export function source(overrides: Partial<Source> = {}): Source {
  return {
    src_id: SRC_ID,
    kb_id: OTHER_KB,
    bucket: 'empresa-runbooks',
    prefix: 'ops/',
    status: 'approved',
    proposed_by: { user_id: baseMe.user_id, email: baseMe.email ?? null },
    proposed_at: '2026-10-20T10:00:00Z',
    decided_by: { user_id: ADMIN_ID, email: 'admin@example.com' },
    decided_at: '2026-10-20T11:00:00Z',
    note: null,
    version: 2,
    role_ready: true,
    can_decide: false,
    ...overrides,
  };
}

export function list(items: KnowledgeBase[], canCreate = true): KnowledgeList {
  return { items, can_create: canCreate };
}
