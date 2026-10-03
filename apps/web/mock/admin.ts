/**
 * Admin v0 (D17) of the mock: budgets, areas and OUs with dual approval, organization and the
 * connectivity check. In-memory state; it includes strings with HTML to check they render as
 * text (TM-A8).
 */
import { auditedWrite } from './audit.ts';
import { MOCK_USER, MOCK_USER_AREA } from './cognito.ts';
import { newId, readObject, sendError, sendJson, type ApiHandler } from './http.ts';
import { handleMfaResets } from './mfaResets.ts';

const DAY_MS = 86_400_000;
const AMOUNT_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;
const AREA_PATTERN = /^[a-z0-9-]{2,32}$/;

const organizationOus = [
  { id: 'ou-a1b2-11111111', name: 'Producción', parent_id: 'r-a1b2', path: ['Producción'] },
  {
    id: 'ou-a1b2-22222222',
    name: 'Finanzas',
    parent_id: 'ou-a1b2-11111111',
    path: ['Producción', 'Finanzas'],
  },
  {
    id: 'ou-a1b2-33333333',
    name: 'Retail',
    parent_id: 'ou-a1b2-11111111',
    path: ['Producción', 'Retail'],
  },
  {
    id: 'ou-a1b2-44444444',
    name: 'Plataforma',
    parent_id: 'ou-a1b2-11111111',
    path: ['Producción', 'Plataforma'],
  },
  {
    id: 'ou-a1b2-55555555',
    name: 'Datos',
    parent_id: 'ou-a1b2-11111111',
    path: ['Producción', 'Datos'],
  },
  { id: 'ou-a1b2-66666666', name: 'No productivo', parent_id: 'r-a1b2', path: ['No productivo'] },
  {
    id: 'ou-a1b2-77777777',
    name: 'Sandbox <img src=x onerror=alert(1)>',
    parent_id: 'ou-a1b2-66666666',
    path: ['No productivo', 'Sandbox <img src=x onerror=alert(1)>'],
  },
  {
    id: 'ou-a1b2-88888888',
    name: 'Staging',
    parent_id: 'ou-a1b2-66666666',
    path: ['No productivo', 'Staging'],
  },
];

type Units = Record<string, string[]>;

interface MockChange {
  change_id: string;
  proposed_by: string;
  proposed_by_email: string | null;
  created_at: string;
  expires_at: string;
  base_version: number;
  units: Units;
  reason: string;
}

const businessUnits: { version: number; units: Units; pending: MockChange[] } = (() => {
  const now = Date.now();
  const units: Units = {
    finanzas: ['ou-a1b2-22222222'],
    retail: ['ou-a1b2-33333333'],
    plataforma: ['ou-a1b2-44444444', 'ou-a1b2-88888888'],
  };
  return {
    version: 3,
    units,
    pending: [
      {
        change_id: newId(),
        proposed_by: 'admin-2',
        proposed_by_email: 'otra.admin@example.com',
        created_at: new Date(now - 2 * 3_600_000).toISOString(),
        expires_at: new Date(now - 2 * 3_600_000 + 7 * DAY_MS).toISOString(),
        base_version: 3,
        units: { ...units, retail: ['ou-a1b2-33333333', 'ou-a1b2-55555555'] },
        reason: 'Datos pasa a reportar a Retail desde octubre.',
      },
      {
        change_id: newId(),
        proposed_by: 'admin-3',
        proposed_by_email: '<b>seguridad</b>@example.com',
        created_at: new Date(now - DAY_MS).toISOString(),
        expires_at: new Date(now + 6 * DAY_MS).toISOString(),
        base_version: 3,
        units: { ...units, finanzas: ['ou-a1b2-22222222', 'ou-a1b2-77777777'] },
        reason: '<script>alert(1)</script> Revisión trimestral del sandbox.',
      },
      {
        // Own proposal: shows "Retirar" (POST .../withdraw).
        change_id: newId(),
        proposed_by: MOCK_USER,
        proposed_by_email: MOCK_USER,
        created_at: new Date(now - 30 * 60_000).toISOString(),
        expires_at: new Date(now - 30 * 60_000 + 7 * DAY_MS).toISOString(),
        base_version: 3,
        units: { ...units, sandbox: ['ou-a1b2-66666666'] },
        reason: 'Crear un área para el equipo que administra Sandbox.',
      },
      {
        // Made on an older version: approving it fails with version_conflict.
        change_id: newId(),
        proposed_by: 'admin-2',
        proposed_by_email: 'otra.admin@example.com',
        created_at: new Date(now - 3 * DAY_MS).toISOString(),
        expires_at: new Date(now + 4 * DAY_MS).toISOString(),
        base_version: 2,
        units: { ...units, plataforma: ['ou-a1b2-44444444'] },
        reason: 'Staging deja de ser responsabilidad de Plataforma.',
      },
    ],
  };
})();

const budgets = {
  version: 1,
  defaults: { user_monthly_usd: '50.00', agent_monthly_usd: '2000.00' },
  agentSpent: '412.35',
  users: [
    { user_id: MOCK_USER, email: MOCK_USER, limit_usd: null as string | null, spent_usd: '12.40' },
    {
      user_id: 'b7e1c2d4-ana',
      email: 'ana.perez@example.com',
      limit_usd: '150.00' as string | null,
      spent_usd: '138.20',
    },
    {
      user_id: 'c9a0f311-luis',
      email: 'luis.gomez@example.com',
      limit_usd: null as string | null,
      spent_usd: '55.10',
    },
    {
      user_id: 'd41d8cd9-sin-correo',
      email: null,
      limit_usd: null as string | null,
      spent_usd: '3.00',
    },
    {
      user_id: 'e0f1a2b3-eve',
      email: '"<img src=x onerror=alert(1)>"@example.com',
      limit_usd: '20.00' as string | null,
      spent_usd: '0.00',
    },
  ],
};

const connectivityCalls: number[] = [];
let connectivityRuns = 0;
let memberAccessRuns = 0;

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function budgetsView() {
  return {
    period: currentPeriod(),
    version: budgets.version,
    defaults: budgets.defaults,
    agents: [
      {
        agent_id: 'finops',
        name: 'FinOps',
        limit_usd: budgets.defaults.agent_monthly_usd,
        spent_usd: budgets.agentSpent,
      },
    ],
    users: budgets.users.map((user) => ({
      user_id: user.user_id,
      email: user.email,
      limit_usd: user.limit_usd ?? budgets.defaults.user_monthly_usd,
      override: user.limit_usd !== null,
      spent_usd: user.spent_usd,
    })),
  };
}

/** Pending changes that have not expired (the API filters the rest out). */
function livePending(): MockChange[] {
  const now = Date.now();
  return businessUnits.pending.filter((change) => Date.parse(change.expires_at) > now);
}

function businessUnitsView() {
  return {
    version: businessUnits.version,
    units: businessUnits.units,
    pending: livePending(),
  };
}

/** Areas added, removed or modified between two mappings. */
function touchedAreas(before: Units, after: Units): Set<string> {
  // Maps, not property reads: `constructor` is a valid area name (ADM-02).
  const was = new Map(Object.entries(before));
  const now = new Map(Object.entries(after));
  const areas = new Set<string>();
  for (const area of new Set([...was.keys(), ...now.keys()])) {
    const a = [...(was.get(area) ?? [])].sort().join(',');
    const b = [...(now.get(area) ?? [])].sort().join(',');
    if (!was.has(area) || !now.has(area) || a !== b) areas.add(area);
  }
  return areas;
}

function validAmount(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    AMOUNT_PATTERN.test(value) &&
    Number(value) > 0 &&
    Number(value) <= 1_000_000
  );
}

function validReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.length <= 500;
}

export const handleAdmin: ApiHandler = async (req, res, path) => {
  if (path.startsWith('/admin/mfa-resets')) return handleMfaResets(req, res, path);
  if (path === '/admin/budgets' && req.method === 'GET') {
    sendJson(res, 200, budgetsView());
    return true;
  }
  if (path === '/admin/budgets/defaults' && req.method === 'PUT') {
    const body = await readObject(req, ['version', 'user_monthly_usd', 'agent_monthly_usd']);
    if (!body || !validAmount(body.user_monthly_usd) || !validAmount(body.agent_monthly_usd)) {
      sendError(res, 422, 'invalid_request', 'Invalid budget defaults');
      return true;
    }
    if (body.version !== budgets.version) {
      sendError(res, 409, 'version_conflict', 'Budgets changed');
      return true;
    }
    const before = { ...budgets.defaults };
    const after = {
      user_monthly_usd: body.user_monthly_usd,
      agent_monthly_usd: body.agent_monthly_usd,
    };
    auditedWrite(
      'settings.budget.updated',
      { scope: 'defaults', before, after, base_version: body.version },
      () => {
        budgets.defaults = after;
        budgets.version += 1;
      },
    );
    sendJson(res, 200, budgetsView());
    return true;
  }
  const userBudget = /^\/admin\/budgets\/users\/([^/]+)$/.exec(path);
  if (userBudget && req.method === 'PUT') {
    const userId = decodeURIComponent(userBudget[1] ?? '');
    const body = await readObject(req, ['version', 'limit_usd']);
    if (!body || (body.limit_usd !== null && !validAmount(body.limit_usd))) {
      sendError(res, 422, 'invalid_request', 'Invalid budget');
      return true;
    }
    if (userId === MOCK_USER) {
      sendError(res, 403, 'self_edit', 'Admins cannot change their own budget');
      return true;
    }
    if (body.version !== budgets.version) {
      sendError(res, 409, 'version_conflict', 'Budgets changed');
      return true;
    }
    let user = budgets.users.find((item) => item.user_id === userId);
    if (!user) {
      user = { user_id: userId, email: null, limit_usd: null, spent_usd: '0.00' };
      budgets.users.push(user);
    }
    const target = user;
    const limit = body.limit_usd;
    auditedWrite(
      'settings.budget.updated',
      {
        scope: `USER#${userId}`,
        target_user: userId,
        before: { limit_usd: target.limit_usd },
        after: { limit_usd: limit },
        base_version: body.version,
      },
      () => {
        target.limit_usd = limit;
        budgets.version += 1;
      },
    );
    sendJson(res, 200, budgetsView());
    return true;
  }
  if (path === '/admin/business-units' && req.method === 'GET') {
    sendJson(res, 200, businessUnitsView());
    return true;
  }
  if (path === '/admin/business-units/changes' && req.method === 'POST') {
    const body = await readObject(req, ['base_version', 'units', 'reason']);
    const units = body?.units;
    if (
      !body ||
      typeof body.base_version !== 'number' ||
      !validReason(body.reason) ||
      typeof units !== 'object' ||
      units === null ||
      Array.isArray(units)
    ) {
      sendError(res, 422, 'invalid_request', 'Invalid change');
      return true;
    }
    const proposed = units as Record<string, unknown>;
    const known = new Set(organizationOus.map((ou) => ou.id));
    for (const [area, ids] of Object.entries(proposed)) {
      if (!AREA_PATTERN.test(area) || !Array.isArray(ids)) {
        sendError(res, 422, 'invalid_request', 'Invalid area');
        return true;
      }
      if (ids.some((id) => typeof id !== 'string' || !known.has(id))) {
        sendError(res, 400, 'unknown_ou', 'Unknown organizational unit');
        return true;
      }
    }
    const typed = proposed as Units;
    if (
      Object.keys(typed).length > 20 ||
      Object.values(typed).some((ids) => ids.length < 1 || ids.length > 15)
    ) {
      sendError(res, 422, 'invalid_request', 'Each area needs 1 to 15 OUs, up to 20 areas');
      return true;
    }
    if (body.base_version !== businessUnits.version) {
      sendError(res, 409, 'version_conflict', 'The mapping changed');
      return true;
    }
    const touched = touchedAreas(businessUnits.units, typed);
    if (touched.size === 0) {
      sendError(res, 422, 'invalid_request', 'The proposal does not change the mapping');
      return true;
    }
    if (touched.has(MOCK_USER_AREA)) {
      sendError(res, 403, 'self_edit', 'The change touches your own area');
      return true;
    }
    if (livePending().length >= 10) {
      sendError(res, 409, 'too_many_pending', 'Too many pending changes');
      return true;
    }
    const now = Date.now();
    const change: MockChange = {
      change_id: newId(),
      proposed_by: MOCK_USER,
      proposed_by_email: MOCK_USER,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 7 * DAY_MS).toISOString(),
      base_version: body.base_version,
      units: typed,
      reason: body.reason.trim(),
    };
    auditedWrite(
      'settings.bu_mapping.proposed',
      {
        change_id: change.change_id,
        proposed_by: MOCK_USER,
        base_version: body.base_version,
        areas_changed: [...touched].sort(),
        before: businessUnits.units,
        after: typed,
        reason: change.reason,
      },
      () => {
        businessUnits.pending.unshift(change);
      },
    );
    sendJson(res, 201, { change_id: change.change_id });
    return true;
  }
  const changeAction =
    /^\/admin\/business-units\/changes\/([A-Za-z0-9_-]+)\/(approve|reject|withdraw)$/.exec(path);
  if (changeAction && req.method === 'POST') {
    const change = businessUnits.pending.find((item) => item.change_id === changeAction[1]);
    if (!change) {
      sendError(res, 404, 'not_found', 'Change not found');
      return true;
    }
    if (changeAction[2] === 'withdraw') {
      if (!(await readObject(req, []))) {
        sendError(res, 422, 'invalid_request', 'Body must be {}');
        return true;
      }
      if (change.proposed_by !== MOCK_USER) {
        sendError(res, 403, 'not_proposer', 'Only the proposer can withdraw this change');
        return true;
      }
      auditedWrite(
        'settings.bu_mapping.withdrawn',
        { change_id: change.change_id, proposed_by: change.proposed_by },
        () => {
          businessUnits.pending = businessUnits.pending.filter((item) => item !== change);
        },
      );
      sendJson(res, 200, businessUnitsView());
      return true;
    }
    if (changeAction[2] === 'reject') {
      const body = await readObject(req, ['reason']);
      if (!body || !validReason(body.reason)) {
        sendError(res, 422, 'invalid_request', 'A reason is required');
        return true;
      }
      if (change.proposed_by === MOCK_USER) {
        sendError(res, 403, 'use_withdraw', 'Withdraw your own proposal instead');
        return true;
      }
      if (touchedAreas(businessUnits.units, change.units).has(MOCK_USER_AREA)) {
        sendError(res, 403, 'self_edit', 'The change touches your own area');
        return true;
      }
      auditedWrite(
        'settings.bu_mapping.rejected',
        {
          change_id: change.change_id,
          proposed_by: change.proposed_by,
          rejected_by: MOCK_USER,
          reason: body.reason,
        },
        () => {
          businessUnits.pending = businessUnits.pending.filter((item) => item !== change);
        },
      );
      sendJson(res, 200, businessUnitsView());
      return true;
    }
    if (!(await readObject(req, []))) {
      sendError(res, 422, 'invalid_request', 'Body must be {}');
      return true;
    }
    if (change.proposed_by === MOCK_USER) {
      sendError(res, 403, 'same_approver', 'The proposer cannot approve');
      return true;
    }
    if (touchedAreas(businessUnits.units, change.units).has(MOCK_USER_AREA)) {
      sendError(res, 403, 'self_edit', 'The change touches your own area');
      return true;
    }
    if (Date.parse(change.expires_at) < Date.now()) {
      sendError(res, 410, 'expired', 'The change expired');
      return true;
    }
    if (change.base_version !== businessUnits.version) {
      sendError(res, 409, 'version_conflict', 'The mapping changed');
      return true;
    }
    auditedWrite(
      'settings.bu_mapping.approved',
      {
        change_id: change.change_id,
        proposed_by: change.proposed_by,
        approved_by: MOCK_USER,
        areas_changed: [...touchedAreas(businessUnits.units, change.units)].sort(),
        before: businessUnits.units,
        after: change.units,
        base_version: change.base_version,
      },
      () => {
        businessUnits.units = change.units;
        businessUnits.version += 1;
        businessUnits.pending = businessUnits.pending.filter((item) => item !== change);
      },
    );
    sendJson(res, 200, businessUnitsView());
    return true;
  }
  if (path === '/admin/organization' && req.method === 'GET') {
    sendJson(res, 200, { ous: organizationOus });
    return true;
  }
  if (path === '/admin/member-access-check' && req.method === 'POST') {
    // Four runs in a loop: more accounts than the check covers, problems (broker identity and
    // a missing role), a check that could not run, and all in order. The failure falls on an
    // odd run, when the connectivity check above is in order, so its own banner shows.
    memberAccessRuns += 1;
    const run = memberAccessRuns % 4;
    if (run === 3) {
      sendError(res, 502, 'upstream_error', 'the member account check could not run');
      return true;
    }
    const bad = run === 2;
    const many = run === 1;
    const accounts = [
      { account_id: '210987654321', name: 'prod-main', status: 'ok' },
      { account_id: '310987654321', name: 'prod-data <img src=x onerror=alert(1)>', status: 'ok' },
      { account_id: '410987654321', name: 'staging', status: bad ? 'identity_not_required' : 'ok' },
      { account_id: '510987654321', name: 'sandbox', status: bad ? 'role_missing' : 'ok' },
      ...(many
        ? Array.from({ length: 46 }, (_, index) => ({
            account_id: String(600000000000 + index),
            name: `team-${String(index + 1).padStart(2, '0')}`,
            status: 'ok',
          }))
        : []),
    ];
    sendJson(res, 200, {
      checked_at: new Date().toISOString(),
      accounts,
      truncated: many,
      total: many ? 63 : accounts.length,
      identity_required: !bad,
    });
    return true;
  }
  if (path === '/admin/connectivity-check' && req.method === 'POST') {
    const now = Date.now();
    while (connectivityCalls.length > 0 && (connectivityCalls[0] ?? 0) < now - 60_000) {
      connectivityCalls.shift();
    }
    if (connectivityCalls.length >= 5) {
      const wait = Math.ceil(((connectivityCalls[0] ?? now) + 60_000 - now) / 1000);
      sendError(res, 429, 'rate_limited', 'Too many connectivity checks', {
        'Retry-After': String(Math.max(1, wait)),
      });
      return true;
    }
    connectivityCalls.push(now);
    connectivityRuns += 1;
    const billingOk = connectivityRuns % 2 === 1;
    sendJson(res, 200, {
      checked_at: new Date(now).toISOString(),
      checks: [
        { name: 'broker', status: 'ok', detail: 'AssumeRole Mango-mock-Broker con SourceIdentity' },
        {
          name: 'billing_reader',
          status: billingOk ? 'ok' : 'error',
          detail: billingOk
            ? 'ce:GetCostAndUsage en 111122223333'
            : 'AccessDenied al asumir Mango-mock-BillingReader (simulado)',
        },
        {
          name: 'organizations',
          status: 'ok',
          detail: `${String(organizationOus.length)} OUs leídas`,
        },
      ],
    });
    return true;
  }
  return false;
};
