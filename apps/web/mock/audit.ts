/** Audit log of the mock: the events the API would write, newest first. */
import { createHash, randomBytes } from 'node:crypto';

import { MOCK_USER } from './cognito.ts';
import { sendJson, type ApiHandler } from './http.ts';

interface MockAuditEvent {
  event_id: string;
  ts: string;
  event: string;
  user_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  actor_is_admin: boolean | null;
  resource?: { type: string; id: string };
  detail: Record<string, unknown>;
  hash: string;
}
/** Newest first, like the API. */
const audit: MockAuditEvent[] = [];

/** Mirror of mango_api.audit.resource_of. */
function auditResource(
  event: string,
  detail: Record<string, unknown>,
): { type: string; id: string } | undefined {
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  if (event === 'policy.decision') {
    const value = text(detail.resource) ?? '';
    const at = value.lastIndexOf('::');
    return at > 0 && at + 2 < value.length
      ? { type: value.slice(0, at), id: value.slice(at + 2) }
      : undefined;
  }
  if (event === 'settings.budget.updated') {
    if (detail.scope === 'defaults') return { type: 'budget_defaults', id: 'defaults' };
    const user = text(detail.target_user);
    return user ? { type: 'user_budget', id: user } : undefined;
  }
  if (event.startsWith('settings.bu_mapping.')) {
    const change = text(detail.change_id);
    return change ? { type: 'bu_change', id: change } : undefined;
  }
  for (const [key, type] of [
    ['change_id', 'change'],
    ['group', 'group'],
    ['target_user', 'user'],
    ['conversation_id', 'conversation'],
    ['agent', 'agent'],
  ] as const) {
    const value = text(detail[key]);
    if (value) return { type, id: value };
  }
  return undefined;
}

export function recordAudit(event: string, detail: Record<string, unknown>): void {
  const resource = auditResource(event, detail);
  const record = {
    event_id: randomBytes(16).toString('hex'),
    // Same format as the API (`+00:00`, milliseconds) so cursors compare the same way.
    ts: new Date().toISOString().replace('Z', '+00:00'),
    event,
    user_id: MOCK_USER,
    actor_email: MOCK_USER,
    actor_role: 'finops-central',
    actor_is_admin: true,
    ...(resource ? { resource } : {}),
    detail,
  };
  const hash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  audit.unshift({ ...record, hash });
  audit.length = Math.min(audit.length, 500);
}

/** GET /api/admin/audit: cursor, range and filters as in mango_api.audit.AuditLog.page. */
function auditPage(params: URLSearchParams): {
  items: MockAuditEvent[];
  next_cursor: string | null;
} {
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 50) || 50, 1), 200);
  const since = Date.parse(params.get('since') ?? '');
  const until = Date.parse(params.get('until') ?? '');
  const cursor = params.get('cursor');
  const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : null;
  const excludeReads = params.getAll('exclude').includes('reads');
  const event = params.get('event');
  const keyOf = (item: MockAuditEvent) => `${item.ts}#${item.event_id}`;
  const matches = audit.filter((item) => {
    const time = Date.parse(item.ts);
    if (!Number.isNaN(since) && time < since) return false;
    if (!Number.isNaN(until) && time >= until) return false;
    if (after !== null && keyOf(item) >= after) return false;
    const read =
      item.event === 'directory.list' ||
      (item.event === 'policy.decision' &&
        item.detail.allowed === true &&
        item.detail.read_only === true);
    if (excludeReads && read) return false;
    if (event) return event.endsWith('.') ? item.event.startsWith(event) : item.event === event;
    return true;
  });
  const items = matches.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor:
      matches.length > limit && last ? Buffer.from(keyOf(last)).toString('base64url') : null,
  };
}

/** Mirror of mango_api.admin._audited: `requested` before the write, then `applied`. */
export function auditedWrite(
  event: string,
  detail: Record<string, unknown>,
  write: () => void,
): void {
  recordAudit(event, { ...detail, outcome: 'requested' });
  write();
  recordAudit(event, { ...detail, outcome: 'applied' });
}

export const handleAudit: ApiHandler = (req, res, path, url) => {
  if (path !== '/admin/audit' || req.method !== 'GET') return Promise.resolve(false);
  // The API audits the read itself (allowed, read-only): hidden unless "Mostrar lecturas".
  recordAudit('policy.decision', {
    action: 'ViewAudit',
    resource: 'Mango::Platform::mango',
    allowed: true,
    read_only: true,
  });
  sendJson(res, 200, auditPage(url.searchParams));
  return Promise.resolve(true);
};
