import { describe, expect, it } from 'vitest';

import { es } from '../../i18n/locales/es';
import {
  csvCell,
  groupTurnAuthz,
  isLateSessionEnd,
  isSessionEndReason,
  isSessionRejectCode,
  mergeRequested,
  outcomeKey,
  SESSION_END_REASONS,
  SESSION_REJECT_CODES,
  toAuditRow,
} from './auditModel';

const event = (name: string, detail: Record<string, unknown>) => ({
  event_id: 'e'.repeat(32),
  ts: '2026-09-30T10:00:00.000Z',
  event: name,
  user_id: 'admin-1',
  detail,
  hash: 'h'.repeat(64),
});

describe('toAuditRow', () => {
  it('maps budget writes to the design actions with before/after and outcome', () => {
    const defaults = toAuditRow(
      event('settings.budget.updated', {
        scope: 'defaults',
        before: { user_monthly_usd: '5', agent_monthly_usd: '30' },
        after: { user_monthly_usd: '10', agent_monthly_usd: '30' },
        outcome: 'applied',
      }),
      0,
    );
    expect(defaults).toMatchObject({
      known: 'budget.default',
      category: 'budgets',
      resource: 'defaults',
      outcome: 'applied',
      detail: { kind: 'defaults', user: '10', agent: '30' },
    });

    const user = toAuditRow(
      event('settings.budget.updated', {
        scope: 'USER#u-2',
        target_user: 'u-2',
        after: { limit_usd: null },
        outcome: 'rejected',
        error: 'version_conflict',
      }),
      1,
    );
    expect(user).toMatchObject({
      known: 'budget.user',
      resource: 'u-2',
      tone: 'red',
      error: 'version_conflict',
      detail: { kind: 'userDefault' },
    });
  });

  it('tells a withdrawal from a rejection and derives the approved version', () => {
    expect(
      toAuditRow(event('settings.bu_mapping.rejected', { change_id: 'c1', withdrawn: true }), 0),
    ).toMatchObject({ known: 'mapping.withdraw', category: 'config', resource: 'c1' });
    expect(
      toAuditRow(event('settings.bu_mapping.rejected', { change_id: 'c1', withdrawn: false }), 0)
        .known,
    ).toBe('mapping.reject');
    expect(
      toAuditRow(event('settings.bu_mapping.approved', { change_id: 'c1', base_version: 4 }), 0)
        .detail,
    ).toEqual({ kind: 'approve', version: 5 });
  });

  it('labels the withdraw endpoint event and keeps the event id as key', () => {
    const row = toAuditRow(
      event('settings.bu_mapping.withdrawn', { change_id: 'c1', outcome: 'applied' }),
      0,
    );
    expect(row).toMatchObject({
      key: 'e'.repeat(32),
      known: 'mapping.withdraw',
      detail: { kind: 'withdraw', changeId: 'c1' },
      resourceKey: 'bu_change:c1',
    });
  });

  it('shows the recorded actor email and design role, else the sub', () => {
    const base = event('settings.budget.updated', { scope: 'defaults' });
    expect(toAuditRow(base, 0)).toMatchObject({ actor: 'admin-1', role: null });
    const cases = [
      [{ actor_role: 'finops-central', actor_is_admin: true }, 'admin'],
      [{ actor_role: 'finops-central', actor_is_admin: false }, 'owner'],
      [{ actor_role: 'bu-lead', actor_is_admin: true }, 'lead_admin'],
      [{ actor_role: 'bu-lead', actor_is_admin: false }, 'user'],
      [{ actor_role: 'other' }, null],
    ] as const;
    for (const [fields, role] of cases) {
      expect(toAuditRow({ ...base, actor_email: 'ana@example.com', ...fields }, 0)).toMatchObject({
        actor: 'ana@example.com',
        role,
      });
    }
  });

  it('prefers the normalized resource and derives it for older events', () => {
    const withResource = {
      ...event('settings.budget.updated', { target_user: 'u-2' }),
      resource: { type: 'user_budget', id: 'u-9' },
    };
    expect(toAuditRow(withResource, 0)).toMatchObject({
      resource: 'u-9',
      resourceKey: 'user_budget:u-9',
    });
    expect(
      toAuditRow(event('policy.decision', { resource: 'Mango::Platform::mango' }), 0),
    ).toMatchObject({ resource: 'mango', resourceKey: 'Mango::Platform:mango' });
    expect(toAuditRow(event('policy.decision', { resource: 'broken' }), 0).resource).toBeNull();
  });

  it('labels the design account.* MFA events', () => {
    expect(toAuditRow(event('account.mfa_enroll', {}), 0)).toMatchObject({
      known: 'account.mfa_enroll',
      category: 'access',
    });
    expect(toAuditRow(event('account.mfa_reset_propose', { target_user: 'u-2' }), 0)).toMatchObject(
      { known: 'account.mfa_reset_propose', tone: 'amber', resource: 'u-2' },
    );
    expect(toAuditRow(event('account.mfa_reset_approve', {}), 0).tone).toBe('green');
    expect(toAuditRow(event('account.mfa_reset_reject', {}), 0).tone).toBe('red');
    expect(toAuditRow(event('account.mfa_reset', {}), 0).known).toBe('account.mfa_reset');
    expect(toAuditRow(event('account.mfa_reset_withdraw', {}), 0).known).toBe(
      'account.mfa_reset_withdraw',
    );
    expect(toAuditRow(event('account.mfa_other', {}), 0).known).toBeNull();
  });

  it('maps authorization decisions to the design access events', () => {
    const decision = (fields: Record<string, unknown>) =>
      toAuditRow(
        event('policy.decision', {
          resource: 'Mango::Platform::mango',
          action: 'ViewAudit',
          ...fields,
        }),
        0,
      );
    expect(decision({ allowed: true, read_only: true })).toMatchObject({
      known: 'access.view',
      category: 'access',
      tone: 'dim',
      detail: { kind: 'access', action: 'ViewAudit', allowed: true },
    });
    // Older decisions without `read_only`: same rule as the API (READ_ACTIONS).
    expect(decision({ allowed: true }).known).toBe('access.view');
    expect(decision({ allowed: false, read_only: true })).toMatchObject({
      known: 'access.denied',
      category: 'access',
      tone: 'red',
      detail: { kind: 'access', action: 'ViewAudit', allowed: false },
    });
    // An allowed write decision is not a read: «Acceso permitido», never the raw event name.
    for (const action of ['UseAgent', 'ManagePeople', 'ApprovePeopleChange']) {
      expect(decision({ allowed: true, read_only: false, action })).toMatchObject({
        known: 'access.allow',
        action: 'access.allow',
        category: 'access',
        tone: 'dim',
        detail: { kind: 'access', action, allowed: true },
      });
    }
    // A decision without a result is not guessed.
    expect(decision({ action: 'ManagePeople' }).known).toBeNull();
  });

  it('shows an allowed chat decision inside its turn and keeps the rest as rows', () => {
    const turn = { conversation_id: 'c1', turn: 't1' };
    const decision = (id: string, fields: Record<string, unknown>) => ({
      ...event('policy.decision', {
        action: 'UseAgent',
        resource: 'Mango::Agent::finops',
        read_only: false,
        ...fields,
      }),
      event_id: id,
    });
    const query = (id: string, fields: Record<string, unknown>) => ({
      ...event('agent.completed', { agent: 'finops', tools: [], cost_usd: '0.01', ...fields }),
      event_id: id,
    });
    const rows = groupTurnAuthz(
      [
        query('q1', { ...turn, authz: { action: 'UseAgent', allowed: true } }),
        decision('d1', { ...turn, allowed: true }),
        // A failed turn: no chat query, so its decision stays visible.
        decision('d2', { conversation_id: 'c1', turn: 't2', allowed: true }),
        // Denied decisions are never grouped.
        decision('d3', { ...turn, allowed: false }),
        // Another actor's decision with the same ids is not this turn's.
        { ...decision('d4', { ...turn, allowed: true }), user_id: 'other' },
        // An older chat query without `authz` or decision gets no section.
        query('q2', { conversation_id: 'c2', turn: 't9' }),
        // The turn start is grouped like the decision; a failed turn's start stays a row.
        { ...event('agent.invoke', { agent: 'finops', ...turn }), event_id: 's1' },
        {
          ...event('agent.invoke', { agent: 'finops', conversation_id: 'c1', turn: 't2' }),
          event_id: 's2',
        },
      ].map(toAuditRow),
    );
    expect(rows.map((row) => row.raw.event_id)).toEqual(['q1', 'd2', 'd3', 'd4', 'q2', 's2']);
    expect(rows[0]?.authz).toMatchObject({
      action: 'UseAgent',
      allowed: true,
      source: { id: 'd1', event: 'policy.decision' },
    });
    expect(rows[0]?.turn).toMatchObject({ id: 't1', start: { id: 's1', event: 'agent.invoke' } });
    expect(rows[2]?.known).toBe('access.denied');
    expect(rows[4]?.authz).toBeNull();
    expect(rows[4]?.turn).toEqual({ id: 't9', start: null });
    expect(rows[5]).toMatchObject({
      known: 'agent.invoke',
      category: 'agents',
      resource: 'finops',
    });
  });

  it('takes the turn authorization from the event, not a fixed value', () => {
    const row = toAuditRow(
      event('agent.completed', {
        agent: 'finops',
        conversation_id: 'c1',
        turn: 't1',
        authz: { action: 'UseAgent', allowed: false },
      }),
      0,
    );
    expect(row.authz).toEqual({ action: 'UseAgent', allowed: false, source: null });
    expect(toAuditRow(event('agent.completed', { authz: { action: 1 } }), 0).authz).toBeNull();
  });

  it('maps a completed agent turn to a chat query about the agent, by the user', () => {
    const row = toAuditRow(
      {
        ...event('agent.completed', {
          agent: 'finops',
          conversation_id: 'conv-1',
          tools: ['a', 'b', 'c'],
          cost_usd: '0.0412',
        }),
        resource: { type: 'conversation', id: 'conv-1' },
      },
      0,
    );
    expect(row).toMatchObject({
      known: 'chat.query',
      category: 'chat',
      actor: 'admin-1',
      resource: 'finops',
      resourceKey: 'agent:finops',
      detail: { kind: 'chat', agent: 'finops', tools: 3, cost: '0.0412' },
    });
  });

  it('records the agent version and the model of a chat turn when the API sent them', () => {
    const row = toAuditRow(
      event('agent.completed', {
        agent: 'finops',
        turn: 'turn-1',
        version: 3,
        model: 'us.anthropic.claude-sonnet-4-6-v1:0',
      }),
      0,
    );
    expect(row).toMatchObject({
      agentVersion: 3,
      model: 'us.anthropic.claude-sonnet-4-6-v1:0',
    });
    // Older events, and anything that is not a version number, show nothing.
    expect(toAuditRow(event('agent.completed', { agent: 'finops' }), 0)).toMatchObject({
      agentVersion: null,
      model: null,
    });
    expect(toAuditRow(event('agent.completed', { version: '3', model: 7 }), 0)).toMatchObject({
      agentVersion: null,
      model: null,
    });
    // Only chat queries carry them: a turn start has its own row format.
    expect(
      toAuditRow(event('agent.invoke', { agent: 'finops', version: 3, model: 'm' }), 0),
    ).toMatchObject({ agentVersion: null, model: null });
  });

  it.each([
    ['agent.provisioner.started', 'agent.publish_start', 'agents'],
    ['agent.version.failed', 'agent.publish_failed', 'agents'],
    ['agent.version.retried', 'agent.retry', 'agents'],
    ['agent.version.reopened', 'agent.reopen', 'agents'],
    ['agent.version.submitted', 'agent.submit', 'agents'],
    ['agent.version.published', 'agent.publish', 'agents'],
    ['agent.retired', 'agent.retire', 'agents'],
    ['settings.model.enabled', 'model.enable', 'mcp'],
    ['settings.model.disabled', 'model.disable', 'mcp'],
    ['settings.model.price_updated', 'model.price', 'mcp'],
    ['settings.models.refreshed', 'model.catalog_sync', 'mcp'],
    ['settings.groups.proposed', 'group.propose', 'access'],
    ['settings.groups.approved', 'group.approve', 'access'],
    ['settings.groups.rejected', 'group.reject', 'access'],
    ['settings.groups.withdrawn', 'group.withdraw', 'access'],
    ['settings.groups.description_updated', 'group.update', 'access'],
    ['approval.policy.propose', 'policy.propose', 'approvals'],
    ['approval.policy.withdraw', 'policy.withdraw', 'approvals'],
    ['approval.request', 'approval.request', 'approvals'],
    ['approval.self_confirm', 'approval.self_confirm', 'approvals'],
    ['approval.expire', 'approval.expire', 'approvals'],
    ['approval.execute', 'approval.execute', 'approvals'],
    ['approval.execute_failed', 'approval.execute_failed', 'approvals'],
    ['approval.cancel', 'approval.cancel', 'approvals'],
    ['mcp.pack.request.withdrawn', 'mcp.withdraw', 'mcp'],
    ['mcp.pack.retried', 'mcp.retry', 'mcp'],
    ['mcp.pack.enabled', 'mcp.enable', 'mcp'],
    ['mcp.pack.disable.requested', 'mcp.disable_request', 'mcp'],
    ['mcp.pack.disabled', 'mcp.disable', 'mcp'],
  ])('labels %s as the design action %s', (name, known, category) => {
    expect(toAuditRow(event(name, { agent: 'k3fq7zr2m5xw6n4a' }), 0)).toMatchObject({
      known,
      action: known,
      category,
    });
  });

  it.each([
    ['mcp.pack.request.proposed', 'enable', 'mcp.request', 'amber'],
    ['mcp.pack.request.proposed', 'params', 'mcp.params_request', 'amber'],
    ['mcp.pack.request.proposed', 'update', 'mcp.update_request', 'amber'],
    ['mcp.pack.request.approved', 'enable', 'mcp.approve', 'green'],
    ['mcp.pack.request.approved', 'update', 'mcp.update_approve', 'green'],
    ['mcp.pack.request.rejected', 'params', 'mcp.params_reject', 'red'],
  ])('names the pack request %s of kind %s as %s', (name, kind, known, tone) => {
    expect(toAuditRow(event(name, { pack: 'aws-billing', kind }), 0)).toMatchObject({
      known,
      category: 'mcp',
      tone,
    });
  });

  it('keeps the raw name of what the design has no label for', () => {
    // A pack request of a kind this screen does not know, and an approval event it has no text for.
    expect(toAuditRow(event('mcp.pack.request.proposed', { kind: 'other' }), 0).known).toBeNull();
    expect(toAuditRow(event('approval.unknown_step', {}), 0)).toMatchObject({
      known: null,
      action: 'approval.unknown_step',
      category: 'approvals',
    });
  });

  it('tells the request to disable a pack (amber) from the platform closing it (red)', () => {
    // Design `actionTone`: a request is amber before «disable» is red.
    expect(
      toAuditRow(event('mcp.pack.disable.requested', { pack: 'aws-billing' }), 0),
    ).toMatchObject({ known: 'mcp.disable_request', tone: 'amber' });
    expect(toAuditRow(event('mcp.pack.disabled', { pack: 'aws-billing' }), 0)).toMatchObject({
      known: 'mcp.disable',
      tone: 'red',
    });
    expect(toAuditRow(event('approval.execute_failed', {}), 0).tone).toBe('red');
  });

  it('shows any action with «fail» in red, also when it reads like a green one', () => {
    // «Publicación fallida» contains «publish» (green): design closing round, red always.
    expect(toAuditRow(event('agent.version.failed', { failed_step: 'x' }), 0).tone).toBe('red');
    expect(
      toAuditRow(event('agent.version.failed', { failed_step: 'x', outcome: 'applied' }), 0).tone,
    ).toBe('red');
    expect(toAuditRow(event('agent.deprovisioner.start_failed', {}), 0).tone).toBe('red');
    expect(toAuditRow(event('agent.version.published', {}), 0).tone).toBe('green');
  });

  it('labels the events of Ajustes › Personas, in «Acceso y grupos»', () => {
    const tones = {
      'directory.list': 'dim',
      'directory.signup': 'dim',
      'directory.invite': 'dim',
      'directory.group_add': 'dim',
      'directory.group_remove': 'dim',
      'directory.disable': 'red',
      'directory.enable': 'green',
      'directory.member_propose': 'amber',
      'directory.member_approve': 'green',
      'directory.member_reject': 'red',
      'directory.member_withdraw': 'dim',
    } as const;
    for (const [name, tone] of Object.entries(tones)) {
      const row = toAuditRow(event(name, { target_user: 'user-9', outcome: 'applied' }), 0);
      expect(row).toMatchObject({ known: name, action: name, category: 'access', tone });
      expect(row.resource).toBe('user-9');
    }
    // Every one of them has a label of the app (the raw event name is never the title).
    for (const name of Object.keys(tones)) {
      expect(es.audit.actions.directory).toHaveProperty(name.replace('directory.', ''));
    }
    // A read records counts only: neither the emails nor the prefix searched.
    expect(
      toAuditRow(
        event('directory.list', {
          filter: 'all',
          searched: true,
          returned: 20,
          outcome: 'applied',
        }),
        0,
      ).detail,
    ).toEqual({ kind: 'directoryRead', read: { scope: 'people', returned: 20, searched: true } });
  });

  it('says what a read of the directory read, with counts and without its outcome', () => {
    const people = toAuditRow(
      event('directory.list', {
        scope: 'people',
        filter: 'pending',
        searched: false,
        returned: 16,
        outcome: 'applied',
      }),
      0,
    );
    expect(people.detail).toEqual({
      kind: 'directoryRead',
      read: { scope: 'people', returned: 16, searched: false },
    });
    // Design: the outcome of a read is not shown.
    expect(people).toMatchObject({ outcome: null, tone: 'dim' });
    const changes = toAuditRow(
      event('directory.list', { scope: 'changes', returned: 16, missing: 14, outcome: 'applied' }),
      0,
    );
    expect(changes.detail).toEqual({
      kind: 'directoryRead',
      read: { scope: 'changes', returned: 16, missing: 14 },
    });
    expect(changes.outcome).toBeNull();
    // Counts that are not counts are not shown as such.
    expect(
      toAuditRow(event('directory.list', { scope: 'changes', returned: '3', missing: -1 }), 0)
        .detail,
    ).toEqual({ kind: 'directoryRead', read: { scope: 'changes', returned: null, missing: 0 } });
    // An event that does not say what was read keeps the generic summary.
    expect(toAuditRow(event('directory.list', { outcome: 'applied' }), 0)).toMatchObject({
      detail: { kind: 'raw', text: 'outcome: applied' },
      outcome: 'applied',
    });
  });

  it('labels a directory lookup and never shows more than the API recorded', () => {
    const row = toAuditRow(
      event('directory.lookup', {
        emails: 2,
        ids: 0,
        emails_found: 1,
        ids_found: 0,
        found_users: ['user-9'],
        outcome: 'applied',
      }),
      0,
    );
    expect(row).toMatchObject({
      known: 'directory.lookup',
      action: 'directory.lookup',
      // Design round of 2026-10-03: the directory is «Acceso y grupos».
      category: 'access',
      tone: 'dim',
      outcome: 'applied',
    });
    // Counts and the users found; the emails asked for are not in the event.
    expect(row.detail).toEqual({
      kind: 'raw',
      text: 'emails: 2 · ids: 0 · emails_found: 1 · ids_found: 0 · found_users: ["user-9"] · outcome: applied',
    });
    // A refused lookup (rate limit) is red, like any write the API refused.
    expect(toAuditRow(event('directory.lookup', { emails: 40, outcome: 'rejected' }), 0).tone).toBe(
      'red',
    );
  });

  it('says how many models a catalog refresh found', () => {
    expect(
      toAuditRow(event('settings.models.refreshed', { added_count: 2, added: ['a', 'b'] }), 0)
        .detail,
    ).toEqual({ kind: 'catalogSync', added: 2 });
    expect(toAuditRow(event('settings.models.refreshed', {}), 0).detail).toEqual({
      kind: 'catalogSync',
      added: 0,
    });
  });

  it('keeps the cleanup of a retired agent in the generic format', () => {
    for (const name of [
      'agent.deprovision',
      'agent.deprovisioner.started',
      'agent.deprovisioner.start_failed',
    ]) {
      const row = toAuditRow(event(name, { agent: 'k3fq7zr2m5xw6n4a', outcome: 'applied' }), 0);
      expect(row).toMatchObject({ known: null, action: name, category: 'agents' });
      expect(row.resource).toBe('k3fq7zr2m5xw6n4a');
      expect(row.detail.kind).toBe('raw');
    }
  });

  it('treats the groups listing as a read with its own permission label', () => {
    const row = toAuditRow(
      event('policy.decision', {
        action: 'ViewGroups',
        resource: 'Mango::Platform::mango',
        allowed: true,
      }),
      0,
    );
    expect(row).toMatchObject({
      known: 'access.view',
      detail: { kind: 'access', action: 'ViewGroups', allowed: true },
    });
  });

  it('keeps unknown events raw, as text', () => {
    const row = toAuditRow(
      event('agent.stopped', { conversation_id: 'conv-1', agent: '<b>x</b>' }),
      0,
    );
    expect(row).toMatchObject({ known: null, action: 'agent.stopped', category: 'agents' });
    expect(row.resource).toBe('conv-1');
    expect(row.detail).toEqual({ kind: 'raw', text: 'conversation_id: conv-1 · agent: <b>x</b>' });
  });

  it('labels a turn start and shows the agent as its resource', () => {
    const row = toAuditRow(
      event('agent.invoke', { conversation_id: 'conv-1', turn: 't1', agent: 'finops' }),
      0,
    );
    expect(row).toMatchObject({
      known: 'agent.invoke',
      category: 'agents',
      tone: 'dim',
      resource: 'finops',
      resourceKey: 'agent:finops',
      turn: null,
    });
  });
});

describe('mergeRequested', () => {
  const write = (id: string, ts: string, outcome: string, extra: Record<string, unknown> = {}) =>
    toAuditRow(
      {
        ...event('directory.group_add', { target_user: 'u-4', group: 'bu-x', outcome, ...extra }),
        event_id: id.padEnd(32, '0'),
        ts,
      },
      0,
    );

  it('shows a request inside the row of its result', () => {
    const applied = write('a2', '2026-09-30T10:00:01.000Z', 'applied');
    const requested = write('a1', '2026-09-30T10:00:00.000Z', 'requested');
    const rows = mergeRequested([applied, requested]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: applied.key,
      outcome: 'applied',
      requested: { id: requested.raw.event_id, ts: requested.ts },
    });
  });

  it('keeps a request without a loaded result, a late result and another resource apart', () => {
    const alone = write('b1', '2026-09-30T10:00:00.000Z', 'requested');
    expect(mergeRequested([alone])).toEqual([alone]);
    const late = write('b2', '2026-09-30T10:02:00.000Z', 'rejected', { error: 'last_admins' });
    expect(mergeRequested([late, alone])).toHaveLength(2);
    const before = write('b3', '2026-09-30T09:59:59.000Z', 'applied');
    expect(mergeRequested([alone, before])).toHaveLength(2);
    const other = write('b4', '2026-09-30T10:00:01.000Z', 'applied', { group: 'bu-y' });
    expect(mergeRequested([other, alone])).toHaveLength(2);
  });

  it('pairs each result with one request only', () => {
    const rows = mergeRequested([
      write('c4', '2026-09-30T10:00:11.000Z', 'applied'),
      write('c3', '2026-09-30T10:00:10.000Z', 'requested'),
      write('c2', '2026-09-30T10:00:01.000Z', 'applied'),
      write('c1', '2026-09-30T10:00:00.000Z', 'requested'),
    ]);
    expect(rows.map((row) => row.requested?.id.slice(0, 2))).toEqual(['c3', 'c1']);
  });
});

describe('sessions', () => {
  it('labels the session events in «Acceso y grupos»', () => {
    const started = toAuditRow(event('session.started', { federated: false, expires_at: 1 }), 0);
    expect(started).toMatchObject({
      known: 'session.started',
      category: 'access',
      tone: 'dim',
      outcome: null,
      detail: { kind: 'session', action: 'session.started' },
    });
    expect(es.audit.actions.session.started).toBe('Sesión iniciada');
    expect(toAuditRow(event('session.renewed', {}), 0)).toMatchObject({
      known: 'session.renewed',
      category: 'access',
      detail: { kind: 'session', action: 'session.renewed' },
    });
  });

  it('tells a sign-in with the SSO of the company from the own login', () => {
    const sso = toAuditRow(event('session.started', { federated: true }), 0);
    expect(sso.detail).toEqual({ kind: 'session', action: 'session.started', sso: true });
    const own = toAuditRow(event('session.started', { federated: false }), 0);
    expect(own.detail).toEqual({ kind: 'session', action: 'session.started', sso: false });
    expect(es.audit.detail.session.startedSso).toBe('Ingresó con el SSO de la empresa');
  });

  it('shows a rejected session as a refusal with its reason as the code', () => {
    const row = toAuditRow(event('session.rejected', { reason: 'sub_mismatch' }), 0);
    expect(row).toMatchObject({
      known: 'session.rejected',
      outcome: 'rejected',
      error: 'sub_mismatch',
      tone: 'red',
      endReason: null,
    });
  });

  it('carries the reason a session ended', () => {
    expect(toAuditRow(event('session.ended', { reason: 'expired' }), 0)).toMatchObject({
      known: 'session.ended',
      endReason: 'expired',
      outcome: null,
    });
    expect(toAuditRow(event('session.ended', {}), 0).endReason).toBeNull();
    expect(toAuditRow(event('directory.disable', { reason: 'x' }), 0).endReason).toBeNull();
  });

  it('has a text for every reason of the design, with the names the API records', () => {
    // `sign_out`, `expired`, the three causes of a revocation, a renewal the identity provider
    // refused and a revocation without a recorded cause (mango_api.web_session).
    expect([...SESSION_END_REASONS]).toEqual([
      'sign_out',
      'expired',
      'disabled',
      'group_removed',
      'mfa_reset',
      'rejected',
      'revoked',
    ]);
    for (const reason of SESSION_END_REASONS) {
      expect(toAuditRow(event('session.ended', { reason }), 0).endReason).toBe(reason);
      expect(isSessionEndReason(reason)).toBe(true);
    }
    // The design's `SESSION_END`, word for word.
    expect(es.audit.sessionEnd).toEqual({
      sign_out: 'La persona cerró sesión',
      expired: 'Venció: pasó la duración máxima de la sesión',
      disabled: 'Un administrador deshabilitó su acceso',
      group_removed: 'Se le quitó un grupo sensible',
      mfa_reset: 'Se restableció su MFA',
      rejected:
        'El proveedor de identidad no la renovó: se revocó o venció allí, o la cuenta se deshabilitó fuera de Mango',
      revoked: 'Un administrador cerró sus sesiones (sin detalle del motivo)',
    });
    // A reason the design does not know is shown as recorded.
    expect(isSessionEndReason('other')).toBe(false);
  });

  it('knows which endings are recorded late and which rejections have a text', () => {
    // Design `SESSION_LATE`: recorded when the browser of the person next tries to renew.
    expect(SESSION_END_REASONS.filter(isLateSessionEnd)).toEqual([
      'disabled',
      'group_removed',
      'mfa_reset',
      'rejected',
      'revoked',
    ]);
    // Design `SESSION_REJECT`, word for word; the codes are the ones mango-api records.
    expect(es.audit.sessionReject).toEqual({
      invalid_refresh_token: 'El ingreso no sirve para crear la sesión',
      sub_mismatch: 'El ingreso es de otra persona',
    });
    expect([...SESSION_REJECT_CODES].every(isSessionRejectCode)).toBe(true);
    expect(isSessionRejectCode('session_revoked')).toBe(false);
    expect(es.audit.detail.session.rejected).toBe('No se pudo crear la sesión tras el ingreso');
  });

  it('names the person of a session that ended like the one that started', () => {
    const who = { actor_email: 'eva@example.com', actor_role: 'finops-central' };
    const started = toAuditRow({ ...event('session.started', {}), ...who }, 0);
    const ended = toAuditRow({ ...event('session.ended', { reason: 'disabled' }), ...who }, 1);
    expect(ended.actor).toBe('eva@example.com');
    expect([ended.actor, ended.role]).toEqual([started.actor, started.role]);
  });
});

describe('outcomeKey', () => {
  it('reads an applied rejection as recorded', () => {
    expect(outcomeKey({ outcome: 'applied', action: 'directory.member_reject' })).toBe('recorded');
    expect(outcomeKey({ outcome: 'applied', action: 'directory.member_approve' })).toBe('applied');
    expect(outcomeKey({ outcome: 'rejected', action: 'mapping.reject' })).toBe('rejected');
    expect(outcomeKey({ outcome: null, action: 'mapping.reject' })).toBeNull();
  });
});

describe('csvCell', () => {
  it('quotes values and neutralizes spreadsheet formulas', () => {
    expect(csvCell('a "b"')).toBe('"a ""b"""');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('+1')).toBe('"\'+1"');
    expect(csvCell(null)).toBe('""');
  });
});
