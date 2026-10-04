/**
 * Mock routes of Ajustes › Personas and of the installation: POST /admin/people/search,
 * POST /admin/people/invitations, the changes that need a second administrator and their
 * decisions, the four changes of one person, and GET /admin/installation. In-memory state in the
 * generated contract (packages/ts/api-client), with the rules of `mango_api.people`: giving or
 * taking `mango-admin` or `finops-central`, disabling an administrator and re-enabling someone
 * with one of those groups are proposed; the rest is applied. The people are the design's
 * `usuarioN@empresa.com`, plus the mock user, who is an administrator.
 */
import { randomBytes } from 'node:crypto';

import { auditedWrite, recordAudit } from './audit.ts';
import { MOCK_USER } from './cognito.ts';
import { registeredGroupIds } from './groups.ts';
import { readBody, sendError, sendJson, type ApiHandler } from './http.ts';

type Status = 'active' | 'invited' | 'disabled';
type Kind = 'add' | 'remove' | 'disable' | 'enable';

interface MockPerson {
  user_id: string;
  email: string;
  status: Status;
  mfa: boolean;
  groups: string[];
  created_at: string;
}

interface MockMemberChange {
  change_id: string;
  kind: Kind;
  group: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  target_user: string;
  target_email: string;
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
const DAY_MS = 24 * HOUR_MS;
const CHANGE_TTL_MS = 72 * HOUR_MS;
const PAGE_SIZE = 20;
const MIN_ADMINS = 2;
const ADMIN = 'mango-admin';
const SYSTEM_GROUPS = [ADMIN, 'mango-agent-creator', 'finops-central', 'bu-lead'];
const SENSITIVE: readonly string[] = [ADMIN, 'finops-central'];
// The domains of the mock administrator and of the people of the directory.
const SIGN_UP_DOMAINS = ['example.com', 'empresa.com'];
/** A sample of the API's rule (`mango_core.mail_domains`): a provider under any country domain. */
const PUBLIC_DOMAIN = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud)(\.[a-z]{2,3}){1,2}$/;
const PREFIX = /^[a-z0-9._%+@-]{1,64}$/;
const CURSOR = /^[0-9]{1,5}$/;
const GROUP_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const EMAIL = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9-]+\.)+[a-z]{2,63}$/;
const FILTERS: readonly string[] = ['all', 'pending', 'invited', 'disabled'];
const PERSON_ROUTE =
  /^\/admin\/people\/([A-Za-z0-9-]{1,64})\/(groups|groups\/remove|disable|enable)$/;
const CHANGE_ROUTE = /^\/admin\/people\/changes\/([0-9a-f]{32})\/(approve|reject|withdraw)$/;

/** Shaped like a Cognito `sub`; the first nine match the directory of `directory.ts`. */
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MOCK_USER_ID = '00000000-0000-4000-8000-0000000000ad';
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

function person(n: number, status: Status, mfa: boolean, groups: string[], days: number) {
  return {
    user_id: idOf(n),
    email: `usuario${String(n)}@empresa.com`,
    status,
    mfa,
    groups: [...groups].sort(),
    created_at: daysAgo(days),
  };
}

/** Design `ROT`, with the groups of the mock registry. */
const ROTATION = [
  ['bu-lead', 'bu-retail'],
  ['toda-la-empresa'],
  ['plataforma-sre'],
  ['bu-lead', 'bu-finanzas'],
  ['seguridad'],
  ['bu-finanzas'],
  ['toda-la-empresa'],
  ['plataforma-sre', 'mango-agent-creator'],
];

const people: MockPerson[] = [
  {
    user_id: MOCK_USER_ID,
    email: MOCK_USER,
    status: 'active',
    mfa: true,
    groups: ['finops-central', ADMIN],
    created_at: daysAgo(230),
  },
  person(1, 'active', true, [ADMIN, 'finops-central'], 210),
  person(2, 'active', true, ['mango-agent-creator', 'finops-central'], 190),
  person(3, 'active', true, ['mango-agent-creator', 'toda-la-empresa'], 160),
  person(4, 'active', true, ['bu-lead', 'bu-finanzas'], 150),
  person(5, 'active', true, ['finops-central'], 120),
  person(6, 'active', true, [ADMIN, 'bu-lead', 'bu-retail'], 200),
  person(7, 'active', true, [], 0.2),
  person(8, 'invited', false, ['bu-finanzas'], 1),
  person(9, 'disabled', true, ['plataforma-sre'], 300),
];
for (let n = 10; n <= 64; n += 1) {
  const status = n % 17 === 0 ? 'disabled' : n % 13 === 0 ? 'invited' : 'active';
  // One disabled person holds a sensitive group: re-enabling them needs a second administrator.
  const groups = n === 17 ? ['finops-central'] : n % 11 === 0 ? [] : ROTATION[n % ROTATION.length];
  people.push(person(n, status, n % 13 !== 0, groups ?? [], 3 + n * 2));
}

function seed(hoursAgo: number, change: Partial<MockMemberChange> & { kind: Kind; n: number }) {
  const { n, ...rest } = change;
  const created = Date.now() - hoursAgo * HOUR_MS;
  return {
    change_id: randomBytes(16).toString('hex'),
    group: null,
    status: 'pending',
    target_user: idOf(n),
    target_email: `usuario${String(n)}@empresa.com`,
    proposed_by: idOf(6),
    proposed_by_email: 'usuario6@empresa.com',
    reason: '',
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + CHANGE_TTL_MS).toISOString(),
    decided_by: null,
    decided_by_email: null,
    decided_at: null,
    note: null,
    ...rest,
  } satisfies MockMemberChange;
}

/** Newest first, like the API. Another administrator proposed them: the mock user decides. */
const changes: MockMemberChange[] = [
  seed(2, {
    kind: 'add',
    n: 2,
    group: ADMIN,
    reason: '<script>alert(1)</script> Cubre las aprobaciones en vacaciones.',
  }),
  seed(90, { kind: 'remove', n: 5, group: 'finops-central', reason: 'Cambió de equipo.' }),
];

const shownStatus = (change: MockMemberChange) =>
  change.status === 'pending' && Date.parse(change.expires_at) <= Date.now()
    ? 'expired'
    : change.status;
const isOpen = (change: MockMemberChange) => shownStatus(change) === 'pending';
const changesView = () => ({
  items: changes.map((change) => ({ ...change, status: shownStatus(change) })),
});

const waiting = (who: MockPerson) => who.status === 'active' && who.groups.length === 0;
const isAdmin = (who: MockPerson) => who.status !== 'disabled' && who.groups.includes(ADMIN);
const admins = () => people.filter(isAdmin);
const assignable = () => new Set([...SYSTEM_GROUPS, ...registeredGroupIds()]);
/** The only administrator is naming the second one (`_is_bootstrap`). */
const isBootstrap = (group: string | null) =>
  group === ADMIN && admins().length === 1 && admins()[0]?.email === MOCK_USER;

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

/** A reason of 1 to 500 characters, `null` when absent, `undefined` when invalid. */
function reasonOf(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && value.length >= 1 && value.length <= 500 ? value : undefined;
}

type Refusal = [status: number, code: string];
const isRefusal = (result: Refusal | object): result is Refusal => Array.isArray(result);

function search(body: Record<string, unknown>): Refusal | object {
  const prefix = body.prefix ?? null;
  const filter = body.filter ?? 'all';
  const cursor = body.cursor ?? null;
  const normalized = typeof prefix === 'string' ? prefix.trim().toLowerCase() : null;
  if (
    (prefix !== null && (normalized === null || !PREFIX.test(normalized))) ||
    typeof filter !== 'string' ||
    !FILTERS.includes(filter) ||
    (cursor !== null && (typeof cursor !== 'string' || !CURSOR.test(cursor)))
  ) {
    return [422, 'invalid_request'];
  }
  const rows = people
    .filter(
      (who) =>
        (normalized === null || who.email.startsWith(normalized)) &&
        (filter === 'all' || (filter === 'pending' ? waiting(who) : who.status === filter)),
    )
    // People waiting for access first, then the newest.
    .sort(
      (a, b) =>
        Number(waiting(b)) - Number(waiting(a)) ||
        Date.parse(b.created_at) - Date.parse(a.created_at) ||
        a.email.localeCompare(b.email),
    );
  const start = Number(cursor ?? '0');
  const items = rows.slice(start, start + PAGE_SIZE);
  // Who read the directory and how much of it; never the emails or the prefix (same as the API).
  recordAudit('directory.list', {
    filter,
    searched: normalized !== null,
    returned: items.length,
    outcome: 'applied',
  });
  return {
    items,
    next_cursor: start + PAGE_SIZE < rows.length ? String(start + PAGE_SIZE) : null,
    pending: people.filter(waiting).length,
    admins: admins().length,
    with_access: people.filter(
      (who) => who.status !== 'disabled' && who.groups.length > 0 && !who.groups.includes(ADMIN),
    ).length,
    incomplete: false,
  };
}

/** The state rules of a change (`_validate`). */
function refusal(kind: Kind, target: MockPerson, group: string | null): Refusal | null {
  if (kind === 'add' || kind === 'remove') {
    if (group === null || !assignable().has(group)) return [422, 'unknown_group'];
    if (target.status === 'disabled') return [409, 'user_disabled'];
    if (kind === 'add' && target.groups.includes(group)) return [409, 'already_member'];
    if (kind === 'remove' && !target.groups.includes(group)) return [409, 'not_member'];
  } else if (kind === 'disable') {
    if (target.status === 'disabled') return [409, 'already_disabled'];
  } else if (target.status !== 'disabled') {
    return [409, 'already_enabled'];
  }
  const removesAdmin = (kind === 'remove' && group === ADMIN) || kind === 'disable';
  return removesAdmin && isAdmin(target) && admins().length <= MIN_ADMINS
    ? [409, 'last_admins']
    : null;
}

function needsApproval(kind: Kind, target: MockPerson, group: string | null): boolean {
  if (kind === 'add' || kind === 'remove') return group !== null && SENSITIVE.includes(group);
  if (kind === 'disable') return isAdmin(target);
  return target.groups.some((own) => SENSITIVE.includes(own));
}

function apply(kind: Kind, target: MockPerson, group: string | null): void {
  if (kind === 'add' && group) target.groups = [...target.groups, group].sort();
  else if (kind === 'remove') target.groups = target.groups.filter((own) => own !== group);
  else if (kind === 'disable') target.status = 'disabled';
  // Someone who never signed in is still invited once enabled.
  else if (kind === 'enable') target.status = target.mfa ? 'active' : 'invited';
}

const EVENTS: Record<Kind, string> = {
  add: 'directory.group_add',
  remove: 'directory.group_remove',
  disable: 'directory.disable',
  enable: 'directory.enable',
};

function detailOf(kind: Kind, target: MockPerson, group: string | null) {
  return {
    target_user: target.user_id,
    target_email: target.email,
    kind,
    ...(group ? { group } : {}),
  };
}

function change(
  kind: Kind,
  target: MockPerson,
  group: string | null,
  reason: string | null,
): Refusal | object {
  const own = target.email === MOCK_USER;
  if (own && kind === 'disable') return [403, 'self_change'];
  const refused = refusal(kind, target, group);
  if (refused) return refused;
  const bootstrap = kind === 'add' && !own && isBootstrap(group);
  if (needsApproval(kind, target, group) && !bootstrap) {
    // Asking for a sensitive group is allowed on one's own account; dropping one is not.
    if (own && kind !== 'add') return [403, 'self_change'];
    if (!reason) return [422, 'reason_required'];
    if (
      changes.some(
        (other) =>
          isOpen(other) &&
          other.target_user === target.user_id &&
          other.kind === kind &&
          other.group === group,
      )
    ) {
      return [409, 'already_pending'];
    }
    const now = Date.now();
    const proposal: MockMemberChange = {
      change_id: randomBytes(16).toString('hex'),
      kind,
      group,
      status: 'pending',
      target_user: target.user_id,
      target_email: target.email,
      proposed_by: MOCK_USER,
      proposed_by_email: MOCK_USER,
      reason,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + CHANGE_TTL_MS).toISOString(),
      decided_by: null,
      decided_by_email: null,
      decided_at: null,
      note: null,
    };
    auditedWrite(
      'directory.member_propose',
      { ...detailOf(kind, target, group), reason, change_id: proposal.change_id },
      () => {
        changes.unshift(proposal);
      },
    );
    return { result: 'proposed', change_id: proposal.change_id };
  }
  if (kind === 'disable' && !reason) return [422, 'reason_required'];
  auditedWrite(
    EVENTS[kind],
    {
      ...detailOf(kind, target, group),
      ...(reason ? { reason } : {}),
      ...(bootstrap ? { bootstrap: true } : {}),
    },
    () => {
      apply(kind, target, group);
    },
  );
  return { result: bootstrap ? 'bootstrap' : 'applied', change_id: null };
}

/** Why `email` cannot be invited (`invitation_domain`), or `null` when it can. */
function invitationRefusal(email: string): string | null {
  if (!EMAIL.test(email)) return 'invalid_email';
  const domain = email.slice(email.indexOf('@') + 1);
  return PUBLIC_DOMAIN.test(domain) ? 'public_domain' : null;
}

function invite(body: Record<string, unknown>): Refusal | object {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const groups: unknown = body.groups ?? [];
  if (
    email.length < 3 ||
    email.length > 254 ||
    !Array.isArray(groups) ||
    groups.length > 10 ||
    !groups.every((group): group is string => typeof group === 'string' && GROUP_ID.test(group))
  ) {
    return [422, 'invalid_request'];
  }
  const refused = invitationRefusal(email);
  if (refused) return [422, refused];
  const wanted = [...new Set(groups)];
  if (wanted.some((group) => !assignable().has(group))) return [422, 'unknown_group'];
  const bootstrap = wanted.includes(ADMIN) && isBootstrap(ADMIN);
  if (wanted.some((group) => SENSITIVE.includes(group) && !(bootstrap && group === ADMIN))) {
    return [422, 'sensitive_group'];
  }
  if (people.some((who) => who.email === email)) return [409, 'already_exists'];
  const invited: MockPerson = {
    user_id: idOf(1000 + people.length),
    email,
    status: 'invited',
    mfa: false,
    groups: wanted.sort(),
    created_at: new Date().toISOString(),
  };
  auditedWrite(
    'directory.invite',
    { target_email: email, groups: wanted, ...(bootstrap ? { bootstrap: true } : {}) },
    () => {
      people.push(invited);
    },
  );
  return { user_id: invited.user_id, result: bootstrap ? 'bootstrap' : 'applied' };
}

function decide(
  found: MockMemberChange,
  action: string,
  body: Record<string, unknown>,
): Refusal | object {
  if (found.status !== 'pending') return [409, 'version_conflict'];
  const mine = found.proposed_by === MOCK_USER;
  const detail = {
    change_id: found.change_id,
    target_user: found.target_user,
    target_email: found.target_email,
    kind: found.kind,
    proposed_by: found.proposed_by,
    ...(found.group ? { group: found.group } : {}),
  };
  const close = (status: MockMemberChange['status'], note: string | null = null) => {
    Object.assign(found, {
      status,
      decided_by: MOCK_USER,
      decided_by_email: MOCK_USER,
      decided_at: new Date().toISOString(),
      note,
    });
  };
  if (action === 'withdraw') {
    if (!mine) return [403, 'forbidden'];
    auditedWrite('directory.member_withdraw', detail, () => {
      close('withdrawn');
    });
    return changesView();
  }
  if (mine) return [403, 'same_approver'];
  if (found.target_email === MOCK_USER) return [403, 'self_change'];
  if (action === 'reject') {
    const reason = reasonOf(body.reason);
    if (!reason) return [422, 'invalid_request'];
    auditedWrite('directory.member_reject', { ...detail, reason }, () => {
      close('rejected', reason);
    });
    return changesView();
  }
  if (Date.parse(found.expires_at) <= Date.now()) return [410, 'expired'];
  const target = people.find((who) => who.user_id === found.target_user);
  if (!target) return [404, 'user_not_found'];
  // The state may have moved since the proposal: every rule is checked again.
  const refused = refusal(found.kind, target, found.group);
  if (refused) return refused;
  auditedWrite('directory.member_approve', { ...detail, approved_by: MOCK_USER }, () => {
    apply(found.kind, target, found.group);
    close('approved');
  });
  recordAudit(EVENTS[found.kind], { ...detail, approved_by: MOCK_USER, outcome: 'applied' });
  return changesView();
}

export const handlePeople: ApiHandler = async (req, res, path) => {
  if (path === '/admin/installation' && req.method === 'GET') {
    sendJson(res, 200, {
      name: 'mango-example',
      version: '0.1.0',
      release: 'v0.1.0-g1a2b3c4',
      organization_id: 'o-exampleorg1',
      management_account_id: '111111111111',
      alerts_emails: ['alertas@example.com'],
      sign_up_domains: SIGN_UP_DOMAINS,
      first_admins: [MOCK_USER, 'usuario1@empresa.com'],
    });
    return true;
  }
  if (!path.startsWith('/admin/people')) return false;
  const answer = (result: Refusal | object, status = 200) => {
    if (isRefusal(result)) sendError(res, result[0], result[1], 'Refused by the mock');
    else sendJson(res, status, result);
    return true;
  };
  if (path === '/admin/people/changes' && req.method === 'GET') return answer(changesView());
  if (req.method !== 'POST') return false;
  if (path === '/admin/people/search') {
    const body = await readJson(req, ['prefix', 'filter', 'cursor']);
    return answer(body ? search(body) : [422, 'invalid_request']);
  }
  if (path === '/admin/people/invitations') {
    const body = await readJson(req, ['email', 'groups']);
    return answer(body ? invite(body) : [422, 'invalid_request'], 201);
  }
  const decision = CHANGE_ROUTE.exec(path);
  if (decision) {
    const action = decision[2] ?? '';
    const body = await readJson(req, action === 'reject' ? ['reason'] : []);
    const found = changes.find((item) => item.change_id === decision[1]);
    if (!body) return answer([422, 'invalid_request']);
    return answer(found ? decide(found, action, body) : [404, 'not_found']);
  }
  const route = PERSON_ROUTE.exec(path);
  if (!route) return false;
  const target = people.find((who) => who.user_id === route[1]);
  if (!target) return answer([404, 'user_not_found']);
  const grouped = route[2] === 'groups' || route[2] === 'groups/remove';
  const body = await readJson(req, grouped ? ['group', 'reason'] : ['reason']);
  const reason = body ? reasonOf(body.reason) : undefined;
  // `disable` takes a `ReasonIn`: the reason is part of the contract, not a rule of the use case.
  if (!body || reason === undefined || (route[2] === 'disable' && reason === null)) {
    return answer([422, 'invalid_request']);
  }
  if (!grouped)
    return answer(change(route[2] === 'disable' ? 'disable' : 'enable', target, null, reason));
  const group = body.group;
  if (typeof group !== 'string' || !GROUP_ID.test(group)) return answer([422, 'invalid_request']);
  return answer(change(route[2] === 'groups' ? 'add' : 'remove', target, group, reason));
};
