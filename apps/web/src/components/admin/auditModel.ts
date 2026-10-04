import type { AuditEvent, AuditResource } from '../../api/schemas';

// Maps the API's audit events onto the design's audit log rows (audit-budgets.jsx). Only data
// present in the event is shown: events written before the API recorded the actor's email and
// role, or the normalized resource, fall back to the `sub` and to a resource derived from
// `detail`. The hash is per event (not chained), so the design's integrity chain stays
// "Próximamente".
//
// Access and chat (design v13): an allowed read-only `policy.decision` is "Acceso de lectura"
// (`access.view`), a denied one "Acceso denegado" (`access.denied`), and `agent.completed` is
// "Consulta del agente" (`chat.query`). The design shows the agent as the actor of a chat query;
// the API records the user who asked, which is what accountability needs, so the actor stays the
// user and the agent is shown as the resource.
//
// Permission actions (design v14 `AUDIT_PERMS`): access rows name the Cedar action the API
// recorded with its design label ("Ver auditoría · permitido"); actions without a label stay raw.
// Per-turn authorization (design v14): the API always audits the chat's `UseAgent` decision on its
// own (fail closed) with the turn ids; when the turn's `chat.query` is loaded, an allowed decision
// is shown inside it ("Autorización") instead of as a separate row. Denied ones are always rows.
// Turn start (design v15): the API audits `agent.invoke` ("Inicio de turno del agente") when the
// agent loop starts; it is shown inside the turn's `chat.query` ("Inicio del turno") the same way,
// and stays a row when the turn did not finish (or its query is not loaded).
//
// Lifecycle and models (design oct 2026): the publication of a version (`agent.version.*`,
// `agent.provisioner.started`) and the changes of Brains (`settings.model.*`,
// `settings.models.refreshed`) get the design's labels. A chat query also shows the version of
// the agent and the model that answered, as the API recorded them. Events the design does not
// name (e.g. `agent.deprovision`) keep the generic format: event name and `key: value` summary.
//
// Directory (design closing round, 2026-10-02): `directory.lookup` is «Búsqueda en el directorio».
// The design's detail names the email that was looked up; the API never records the emails asked
// for (only how many, and who was found), so the detail stays the generic summary of the event.
//
// People (design round of 2026-10-03): the `directory.*` events of Ajustes › Personas keep their
// name in the API and get the design's labels, in «Acceso y grupos», with «Abrir Ajustes».
// `directory.list` (reading the directory) is not in the design: «Lectura del directorio».

/** Design categories (AUDIT_CATS), in the design's order. */
export const AUDIT_CATEGORIES = [
  'agents',
  'approvals',
  'budgets',
  'access',
  'mcp',
  'config',
  'chat',
  'tickets',
  'system',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * Design `account.*` MFA events (design v10/v11 AUDIT_ACTIONS). The API does not emit them yet; when
 * it does with these names they get their label instead of the raw event name.
 */
const ACCOUNT_ACTIONS = [
  'account.mfa_enroll',
  'account.mfa_reset',
  'account.mfa_reset_propose',
  'account.mfa_reset_approve',
  'account.mfa_reset_reject',
  'account.mfa_reset_withdraw',
] as const;
type AccountAction = (typeof ACCOUNT_ACTIONS)[number];
const ACCOUNT_ACTION_SET: ReadonlySet<string> = new Set(ACCOUNT_ACTIONS);
const isAccountAction = (event: string): event is AccountAction => ACCOUNT_ACTION_SET.has(event);

/** Directory events the API records with the name of their design action (AUDIT_ACTIONS). */
const DIRECTORY_ACTIONS = [
  'directory.lookup',
  'directory.list',
  'directory.signup',
  'directory.invite',
  'directory.group_add',
  'directory.group_remove',
  'directory.disable',
  'directory.enable',
  'directory.member_propose',
  'directory.member_approve',
  'directory.member_reject',
  'directory.member_withdraw',
] as const;
type DirectoryAction = (typeof DIRECTORY_ACTIONS)[number];
const DIRECTORY_ACTION_SET: ReadonlySet<string> = new Set(DIRECTORY_ACTIONS);
const isDirectoryAction = (event: string): event is DirectoryAction =>
  DIRECTORY_ACTION_SET.has(event);

/** Approval events the API records with the name of their design action (AUDIT_ACTIONS). */
const APPROVAL_ACTIONS = [
  'approval.request',
  'approval.approve',
  'approval.reject',
  'approval.execute',
  'approval.execute_failed',
  'approval.cancel',
  'approval.expire',
  'approval.self_confirm',
  'approval.self_cancel',
] as const;
type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
const APPROVAL_ACTION_SET: ReadonlySet<string> = new Set(APPROVAL_ACTIONS);
const isApprovalAction = (event: string): event is ApprovalAction => APPROVAL_ACTION_SET.has(event);

/**
 * A pack request is one event per step; the design names it by what was asked (`detail.kind`):
 * to enable the pack, to change its parameters or to update it.
 */
const PACK_REQUEST_ACTIONS = {
  'mcp.pack.request.proposed': {
    enable: 'mcp.request',
    params: 'mcp.params_request',
    update: 'mcp.update_request',
  },
  'mcp.pack.request.approved': {
    enable: 'mcp.approve',
    params: 'mcp.params_approve',
    update: 'mcp.update_approve',
  },
  'mcp.pack.request.rejected': {
    enable: 'mcp.reject',
    params: 'mcp.params_reject',
    update: 'mcp.update_reject',
  },
} as const;
type PackRequestEvent = keyof typeof PACK_REQUEST_ACTIONS;
type PackRequestKind = keyof (typeof PACK_REQUEST_ACTIONS)[PackRequestEvent];
type PackRequestAction = (typeof PACK_REQUEST_ACTIONS)[PackRequestEvent][PackRequestKind];
const isPackRequest = (event: string): event is PackRequestEvent =>
  Object.hasOwn(PACK_REQUEST_ACTIONS, event);
const isPackRequestKind = (kind: unknown): kind is PackRequestKind =>
  kind === 'enable' || kind === 'params' || kind === 'update';

/**
 * API events of the agent lifecycle, Brains, groups, tool policies and packs, by their design
 * action (AUDIT_ACTIONS).
 */
const EVENT_ACTIONS = {
  'agent.created': 'agent.create',
  'agent.retired': 'agent.retire',
  'agent.version.saved': 'agent.draft',
  'agent.version.submitted': 'agent.submit',
  'agent.version.approved': 'agent.approve',
  'agent.version.rejected': 'agent.reject',
  'agent.version.published': 'agent.publish',
  'agent.provisioner.started': 'agent.publish_start',
  'agent.version.failed': 'agent.publish_failed',
  'agent.version.retried': 'agent.retry',
  'agent.version.reopened': 'agent.reopen',
  'settings.model.enabled': 'model.enable',
  'settings.model.disabled': 'model.disable',
  'settings.model.price_updated': 'model.price',
  'settings.models.refreshed': 'model.catalog_sync',
  'settings.groups.proposed': 'group.propose',
  'settings.groups.approved': 'group.approve',
  'settings.groups.rejected': 'group.reject',
  'settings.groups.withdrawn': 'group.withdraw',
  'settings.groups.description_updated': 'group.update',
  'approval.policy.propose': 'policy.propose',
  'approval.policy.approve': 'policy.approve',
  'approval.policy.reject': 'policy.reject',
  'approval.policy.withdraw': 'policy.withdraw',
  'mcp.pack.request.withdrawn': 'mcp.withdraw',
  'mcp.pack.retried': 'mcp.retry',
  'mcp.pack.enabled': 'mcp.enable',
  // The admin asks to disable (`mcp.disable_request`); the platform closes it (`mcp.disable`).
  'mcp.pack.disable.requested': 'mcp.disable_request',
  'mcp.pack.disabled': 'mcp.disable',
} as const;
type EventAction = (typeof EVENT_ACTIONS)[keyof typeof EVENT_ACTIONS];
const hasEventAction = (event: string): event is keyof typeof EVENT_ACTIONS =>
  Object.hasOwn(EVENT_ACTIONS, event);

/** Design action keys with a Spanish label (AUDIT_ACTIONS) that the API can produce. */
export type KnownAction =
  | 'budget.default'
  | 'budget.user'
  | 'mapping.propose'
  | 'mapping.approve'
  | 'mapping.reject'
  | 'mapping.withdraw'
  | 'access.view'
  | 'access.denied'
  | 'chat.query'
  | 'agent.invoke'
  | DirectoryAction
  | EventAction
  | PackRequestAction
  | ApprovalAction
  | AccountAction;

/** Design `AUDIT_PERMS`: Cedar actions with a Spanish label (`audit.perms.*`). */
export const PERM_ACTIONS = ['ViewAudit', 'ViewAdmin', 'UseAgent', 'ViewGroups'] as const;
export type PermAction = (typeof PERM_ACTIONS)[number];
const PERM_SET: ReadonlySet<string> = new Set(PERM_ACTIONS);
export const isPermAction = (action: string): action is PermAction => PERM_SET.has(action);

/** An audit event grouped inside a chat query (design: "Evento · `id · action`"). */
export interface EventRef {
  id: string;
  event: string;
  ts: string;
}

/** Authorization of a chat turn, as recorded by the API (never assumed). */
export interface TurnAuthz {
  action: string;
  allowed: boolean;
  /** The `UseAgent` decision when it was loaded; null when it comes from `detail.authz`. */
  source: EventRef | null;
}

export type Outcome = 'requested' | 'applied' | 'rejected';

/** Design `ROLE_L` keys, from the role and admin flag the API recorded with the event. */
export type ActorRole = 'lead_admin' | 'admin' | 'owner' | 'user';

export type DetailText =
  | { kind: 'defaults'; user: string | null; agent: string | null }
  | { kind: 'userDefault' }
  | { kind: 'userOwn'; amount: string }
  | { kind: 'propose'; reason: string }
  | { kind: 'approve'; version: number | null }
  | { kind: 'reject'; reason: string }
  | { kind: 'withdraw'; changeId: string }
  | { kind: 'access'; action: string; allowed: boolean }
  | { kind: 'chat'; agent: string; tools: number; cost: string | null }
  | { kind: 'catalogSync'; added: number }
  | { kind: 'raw'; text: string };

export interface AuditRow {
  key: string;
  ts: string;
  time: number;
  event: string;
  /** Design action key when known, else the raw event name. */
  action: string;
  known: KnownAction | null;
  outcome: Outcome | null;
  error: string | null;
  /** Display name: the actor's email when recorded, else the `sub`. */
  actor: string;
  role: ActorRole | null;
  /** Resource id shown in the row; `resourceKey` (`type:id`) is what the filter compares. */
  resource: string | null;
  resourceKey: string | null;
  detail: DetailText;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  category: AuditCategory;
  tone: 'red' | 'amber' | 'green' | 'dim';
  /** `chat.query` only: the turn's authorization, from its decision or from `detail.authz`. */
  authz: TurnAuthz | null;
  /** `chat.query` only: the turn id and its `agent.invoke` event, when that event is loaded. */
  turn: { id: string; start: EventRef | null } | null;
  /** `chat.query` only: version of the agent and model that answered, when recorded. */
  agentVersion: number | null;
  model: string | null;
  /** Actor + `conversation_id` + `turn` of a chat query, its `agent.invoke` or allowed `UseAgent`. */
  turnKey: string | null;
  raw: AuditEvent;
}

/** Design `.au-outcome` (`.fail` when the API refused the write). */
export const outcomeClass = (row: Pick<AuditRow, 'outcome'>): string =>
  row.outcome === 'rejected' ? 'au-outcome fail' : 'au-outcome';

export const TONE_COLOR: Record<AuditRow['tone'], string> = {
  red: 'var(--red)',
  amber: 'var(--amber)',
  green: 'var(--green)',
  dim: 'var(--text-dim)',
};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Same as the API's `audit.READ_ACTIONS`, for decisions written before `read_only` existed. */
const READ_ACTIONS: ReadonlySet<string> = new Set(['ViewAdmin', 'ViewAudit', 'ViewGroups']);

/** Same rule as the API's `audit.is_read` (what `exclude=reads` hides). */
function isRead(detail: Record<string, unknown>): boolean {
  return (
    detail.allowed === true &&
    (detail.read_only === true ||
      (typeof detail.action === 'string' && READ_ACTIONS.has(detail.action)))
  );
}

function knownAction(event: string, detail: Record<string, unknown>): KnownAction | null {
  switch (event) {
    case 'policy.decision':
      if (detail.allowed === false) return 'access.denied';
      return isRead(detail) ? 'access.view' : null;
    case 'agent.completed':
      return 'chat.query';
    case 'agent.invoke':
      return 'agent.invoke';
    case 'settings.budget.updated':
      return detail.scope === 'defaults' ? 'budget.default' : 'budget.user';
    case 'settings.bu_mapping.proposed':
      return 'mapping.propose';
    case 'settings.bu_mapping.approved':
      return 'mapping.approve';
    case 'settings.bu_mapping.withdrawn':
      return 'mapping.withdraw';
    case 'settings.bu_mapping.rejected':
      // Before the withdraw endpoint the proposer rejected their own change (`withdrawn: true`).
      return detail.withdrawn === true ? 'mapping.withdraw' : 'mapping.reject';
    default:
      if (hasEventAction(event)) return EVENT_ACTIONS[event];
      if (isPackRequest(event)) {
        return isPackRequestKind(detail.kind) ? PACK_REQUEST_ACTIONS[event][detail.kind] : null;
      }
      if (isApprovalAction(event)) return event;
      if (isDirectoryAction(event)) return event;
      return isAccountAction(event) ? event : null;
  }
}

function categoryOf(action: string): AuditCategory {
  if (/^agent\./.test(action)) return 'agents';
  if (/^(approval|policy)\./.test(action)) return 'approvals';
  if (/^budget\./.test(action)) return 'budgets';
  if (/^(role|group|access|account|conversation|directory)\./.test(action)) return 'access';
  if (/^(mcp|tool|model)\./.test(action)) return 'mcp';
  if (/^(settings|mapping|kb|schedule)\./.test(action)) return 'config';
  if (action === 'chat.query') return 'chat';
  if (/^ticket\./.test(action)) return 'tickets';
  return 'system';
}

/**
 * Design `actionTone`; a write the API refused is red whatever the action. Any action with
 * «fail» is red before the other tones are tried: «Publicación fallida» (`agent.publish_failed`)
 * also contains «publish», which is green.
 */
function toneOf(action: string, outcome: Outcome | null): AuditRow['tone'] {
  if (outcome === 'rejected') return 'red';
  // A request (`*.request`, `*_request`) is amber before «disable» is red: asking is not doing.
  if (/[._]request$/.test(action)) return 'amber';
  if (/reject|fail|pause|error|delete|disable|retire|exceeded|denied/.test(action)) return 'red';
  if (/alert|request|submit|propose/.test(action)) return 'amber';
  if (/approve|create|publish|enable|restore/.test(action)) return 'green';
  return 'dim';
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

const SUMMARY_MAX = 240;
/** One-line `key: value` summary for events without a design sentence. */
function summarize(detail: Record<string, unknown>): string {
  const text = Object.entries(detail)
    .map(([key, value]) => `${key}: ${stringify(value)}`)
    .join(' · ');
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

function detailOf(
  event: string,
  known: KnownAction | null,
  detail: Record<string, unknown>,
): DetailText {
  const after = obj(detail.after);
  switch (known) {
    case 'budget.default':
      return {
        kind: 'defaults',
        user: str(after?.user_monthly_usd),
        agent: str(after?.agent_monthly_usd),
      };
    case 'budget.user': {
      const amount = str(after?.limit_usd);
      return amount ? { kind: 'userOwn', amount } : { kind: 'userDefault' };
    }
    case 'mapping.propose':
      return { kind: 'propose', reason: str(detail.reason) ?? '' };
    case 'mapping.approve': {
      const base = detail.base_version;
      return { kind: 'approve', version: typeof base === 'number' ? base + 1 : null };
    }
    case 'mapping.reject':
      return { kind: 'reject', reason: str(detail.reason) ?? '' };
    case 'mapping.withdraw':
      return { kind: 'withdraw', changeId: str(detail.change_id) ?? '' };
    case 'access.view':
    case 'access.denied':
      return { kind: 'access', action: str(detail.action) ?? '', allowed: known === 'access.view' };
    case 'chat.query': {
      const tools = Array.isArray(detail.tools) ? detail.tools.length : 0;
      return { kind: 'chat', agent: str(detail.agent) ?? '', tools, cost: str(detail.cost_usd) };
    }
    case 'model.catalog_sync':
      return {
        kind: 'catalogSync',
        added: typeof detail.added_count === 'number' ? detail.added_count : 0,
      };
    default:
      // Any other decision (e.g. the chat's `UseAgent` of a turn that did not complete).
      return event === 'policy.decision' && typeof detail.action === 'string'
        ? { kind: 'access', action: detail.action, allowed: detail.allowed === true }
        : { kind: 'raw', text: summarize(detail) };
  }
}

const GENERIC_RESOURCES = [
  ['change_id', 'change'],
  ['group', 'group'],
  ['target_user', 'user'],
  ['conversation_id', 'conversation'],
  ['agent', 'agent'],
] as const;

/** Same derivation as the API (`audit.resource_of`), for events written without `resource`. */
function derivedResource(event: string, detail: Record<string, unknown>): AuditResource | null {
  if (event === 'policy.decision') {
    const value = str(detail.resource) ?? '';
    const at = value.lastIndexOf('::');
    return at > 0 && at + 2 < value.length
      ? { type: value.slice(0, at), id: value.slice(at + 2) }
      : null;
  }
  if (event === 'settings.budget.updated') {
    if (detail.scope === 'defaults') return { type: 'budget_defaults', id: 'defaults' };
    const user = str(detail.target_user);
    return user ? { type: 'user_budget', id: user } : null;
  }
  if (event.startsWith('settings.bu_mapping.')) {
    const change = str(detail.change_id);
    return change ? { type: 'bu_change', id: change } : null;
  }
  for (const [key, type] of GENERIC_RESOURCES) {
    const value = str(detail[key]);
    if (value) return { type, id: value };
  }
  return null;
}

function authzOf(detail: Record<string, unknown>): TurnAuthz | null {
  const authz = obj(detail.authz);
  const action = str(authz?.action);
  return action && typeof authz?.allowed === 'boolean'
    ? { action, allowed: authz.allowed, source: null }
    : null;
}

function turnKeyOf(item: AuditEvent): string | null {
  const { event, detail } = item;
  const conversation = str(detail.conversation_id);
  const turn = str(detail.turn);
  // The turn id is server-random; the actor is part of the key so only their own turn matches.
  if (!conversation || !turn || !item.user_id) return null;
  const key = `${item.user_id}:${conversation}:${turn}`;
  if (event === 'agent.completed' || event === 'agent.invoke') return key;
  // Only an allowed `UseAgent` is grouped; a denied one never reaches a chat query.
  const grouped =
    event === 'policy.decision' && detail.action === 'UseAgent' && detail.allowed === true;
  return grouped ? key : null;
}

function roleOf(item: AuditEvent): ActorRole | null {
  if (item.actor_role === 'finops-central') return item.actor_is_admin ? 'admin' : 'owner';
  if (item.actor_role === 'bu-lead') return item.actor_is_admin ? 'lead_admin' : 'user';
  return null;
}

export function toAuditRow(item: AuditEvent, index: number): AuditRow {
  const detail = item.detail;
  const known = knownAction(item.event, detail);
  const action = known ?? item.event;
  const outcomeValue = str(detail.outcome);
  const outcome =
    outcomeValue === 'requested' || outcomeValue === 'applied' || outcomeValue === 'rejected'
      ? outcomeValue
      : null;
  const time = Date.parse(item.ts);
  // A chat turn is about the agent that answered (the stored resource is the conversation).
  const agent = known === 'chat.query' || known === 'agent.invoke' ? str(detail.agent) : null;
  const turn = known === 'chat.query' ? str(detail.turn) : null;
  const version = known === 'chat.query' ? detail.version : null;
  const resource = agent
    ? { type: 'agent', id: agent }
    : (item.resource ?? derivedResource(item.event, detail));
  return {
    key: item.event_id || `${item.ts}-${item.event}-${String(index)}`,
    ts: item.ts,
    time: Number.isNaN(time) ? 0 : time,
    event: item.event,
    action,
    known,
    outcome,
    error: str(detail.error),
    actor: item.actor_email ?? item.user_id ?? '',
    role: roleOf(item),
    resource: resource ? resource.id : null,
    resourceKey: resource ? `${resource.type}:${resource.id}` : null,
    detail: detailOf(item.event, known, detail),
    before: obj(detail.before),
    after: obj(detail.after),
    category: categoryOf(action),
    tone: toneOf(action, outcome),
    authz: known === 'chat.query' ? authzOf(detail) : null,
    turn: turn ? { id: turn, start: null } : null,
    agentVersion: typeof version === 'number' && Number.isInteger(version) ? version : null,
    model: known === 'chat.query' ? str(detail.model) : null,
    turnKey: turnKeyOf(item),
    raw: item,
  };
}

const refOf = (row: AuditRow): EventRef => ({ id: row.raw.event_id, event: row.event, ts: row.ts });

/**
 * Shows each loaded turn's `agent.invoke` and allowed `UseAgent` decision inside its `chat.query`
 * (the authorization result comes from the decision) and drops them as rows; those whose chat
 * query is not loaded (a failed turn, or one on a later page) stay rows, so nothing is hidden.
 */
export function groupTurnAuthz(rows: AuditRow[]): AuditRow[] {
  const queries = new Set<string>();
  for (const row of rows) if (row.known === 'chat.query' && row.turnKey) queries.add(row.turnKey);
  const decisions = new Map<string, TurnAuthz>();
  const starts = new Map<string, EventRef>();
  const out: AuditRow[] = [];
  for (const row of rows) {
    if (row.turnKey && queries.has(row.turnKey) && row.known !== 'chat.query') {
      if (row.event === 'policy.decision') {
        const action = str(row.raw.detail.action) ?? 'UseAgent';
        const allowed = row.raw.detail.allowed === true;
        decisions.set(row.turnKey, { action, allowed, source: refOf(row) });
      } else {
        starts.set(row.turnKey, refOf(row));
      }
    } else {
      out.push(row);
    }
  }
  return out.map((row) => {
    if (row.known !== 'chat.query' || !row.turnKey) return row;
    const authz = decisions.get(row.turnKey) ?? row.authz;
    const start = starts.get(row.turnKey) ?? null;
    const turn = row.turn ? { ...row.turn, start } : null;
    return authz === row.authz && !start ? row : { ...row, authz, turn };
  });
}

/** Local-midnight timestamp of a date, to group rows by day. */
export function dayKey(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Formula-injection-safe CSV cell (a spreadsheet must not execute `=…`, `+…`, `@…`). */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
