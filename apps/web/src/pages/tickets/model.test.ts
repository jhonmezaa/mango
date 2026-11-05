import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/errors';
import {
  NO_FILTERS,
  activity,
  agentLost,
  assignable,
  canMoveTo,
  errorKey,
  listed,
  parseTicketId,
  shortId,
  sorted,
  withTicket,
} from './model';
import { ME, OTHER, THIRD, detail, person, ticket } from './testFixtures';

describe('ids', () => {
  it('shows the first eight characters of the random id', () => {
    expect(shortId('abcdefgh2345')).toBe('abcdefgh');
  });

  it('only takes an id of the API from the URL', () => {
    expect(parseTicketId('abcdefgh2345')).toBe('abcdefgh2345');
    for (const bad of ['MNG-1', 'abcdefgh', 'abcdefgh23456', 'abcdefgh234"', undefined, 7]) {
      expect(parseTicketId(bad)).toBeNull();
    }
  });
});

describe('listed', () => {
  const mine = ticket({ assignee: person(ME), priority: 'high' });
  const free = ticket({ title: 'Otro tema', priority: 'high', status: 'done' });
  const theirs = ticket({ assignee: person(OTHER), agent_id: 'finops' });
  const all = [mine, free, theirs];

  it('counts each quick view over the search and the filters', () => {
    const { shown, counts } = listed(all, '', NO_FILTERS, 'all', ME);
    expect(shown).toHaveLength(3);
    // «Prioridad alta» leaves out what is resolved.
    expect(counts).toEqual({ all: 3, mine: 1, unassigned: 1, high: 1 });
  });

  it('searches by title and by the short or the whole id', () => {
    expect(listed(all, 'otro', NO_FILTERS, 'all', ME).shown).toEqual([free]);
    expect(listed(all, shortId(theirs.ticket_id), NO_FILTERS, 'all', ME).shown).toEqual([theirs]);
    expect(listed(all, theirs.ticket_id, NO_FILTERS, 'all', ME).shown).toEqual([theirs]);
  });

  it('filters by status, priority, agent and assignee', () => {
    const only = (filters: Partial<typeof NO_FILTERS>) =>
      listed(all, '', { ...NO_FILTERS, ...filters }, 'all', ME).shown;
    expect(only({ status: new Set(['done']) })).toEqual([free]);
    expect(only({ priority: new Set(['medium']) })).toEqual([theirs]);
    expect(only({ agent: 'finops' })).toEqual([theirs]);
    expect(only({ assignee: 'none' })).toEqual([free]);
    expect(only({ assignee: 'me' })).toEqual([mine]);
  });

  it('applies the quick view after counting', () => {
    const { shown, counts } = listed(all, '', NO_FILTERS, 'mine', ME);
    expect(shown).toEqual([mine]);
    expect(counts.all).toBe(3);
  });
});

describe('canMoveTo', () => {
  it('never moves a ticket to «Por aprobar»', () => {
    expect(canMoveTo({ status: 'open' }, 'needs_approval')).toBe(false);
  });

  it('takes a ticket out of «Por aprobar» only as resolved', () => {
    expect(canMoveTo({ status: 'needs_approval' }, 'done')).toBe(true);
    expect(canMoveTo({ status: 'needs_approval' }, 'open')).toBe(false);
    expect(canMoveTo({ status: 'needs_approval' }, 'in_progress')).toBe(false);
  });

  it('moves between the other columns', () => {
    expect(canMoveTo({ status: 'open' }, 'in_progress')).toBe(true);
    expect(canMoveTo({ status: 'done' }, 'open')).toBe(true);
    expect(canMoveTo({ status: 'open' }, 'open')).toBe(false);
  });
});

describe('assignable', () => {
  it('offers the person first and then whoever takes part', () => {
    const item = detail({
      creator: person(OTHER),
      participants: [person(OTHER), person(THIRD)],
    });
    expect(assignable(item, ME).map((p) => p.user_id)).toEqual([ME, OTHER, THIRD]);
  });

  it('does not repeat the person when they already take part', () => {
    const item = detail({ participants: [person(ME), person(OTHER)] });
    expect(assignable(item, ME).map((p) => p.user_id)).toEqual([ME, OTHER]);
  });
});

describe('agentLost', () => {
  it('is lost when the agent is not among the usable ones', () => {
    expect(agentLost({ agent_id: 'gone' }, new Set(['finops']))).toBe(true);
    expect(agentLost({ agent_id: 'finops' }, new Set(['finops']))).toBe(false);
    expect(agentLost({ agent_id: null }, new Set())).toBe(false);
    // Still loading: nothing is said.
    expect(agentLost({ agent_id: 'gone' }, null)).toBe(false);
  });
});

describe('activity', () => {
  it('starts with how it was created and shows each change of the history', () => {
    const item = detail({ source: 'agent', agent_name: 'FinOps', assignee: person(ME) });
    item.history.push({
      actor: person(OTHER),
      action: 'changed',
      field: 'status',
      before: 'open',
      after: 'in_progress',
      created_at: new Date().toISOString(),
    });
    item.history.push({
      actor: person(OTHER),
      action: 'commented',
      field: null,
      before: null,
      after: null,
      created_at: new Date().toISOString(),
    });
    const lines = activity(item);
    expect(lines.map((line) => line.kind)).toEqual(['created', 'assigned', 'changed']);
    expect(lines[0]).toMatchObject({ source: 'agent', agent: 'FinOps' });
  });

  it('says «Por aprobar» and does not repeat an assignment the history has', () => {
    const item = detail({ status: 'needs_approval', assignee: person(ME) });
    item.history.push({
      actor: person(ME),
      action: 'changed',
      field: 'assignee',
      before: null,
      after: ME,
      created_at: new Date().toISOString(),
    });
    expect(activity(item).map((line) => line.kind)).toEqual(['created', 'approval', 'changed']);
  });
});

describe('sorted and withTicket', () => {
  it('sorts the newest first by default age and inverts it', () => {
    const old = ticket({ created_at: '2026-11-01T00:00:00Z' });
    const recent = ticket({ created_at: '2026-11-04T00:00:00Z' });
    expect(sorted([old, recent], { key: 'age', dir: 1 })).toEqual([recent, old]);
    expect(sorted([old, recent], { key: 'age', dir: -1 })).toEqual([old, recent]);
  });

  it('replaces a ticket in place and adds a new one first', () => {
    const a = ticket();
    const b = ticket();
    expect(withTicket([a, b], { ...b, title: 'x' })[1]?.title).toBe('x');
    const c = ticket();
    expect(withTicket([a, b], c)[0]).toBe(c);
  });
});

describe('errorKey', () => {
  it('names each refusal of the API', () => {
    expect(errorKey(new ApiError(409, 'ticket_changed', ''))).toBe('tickets.error.changed');
    expect(errorKey(new ApiError(422, 'secret_in_ticket', ''))).toBe('tickets.error.secret');
    expect(errorKey(new ApiError(422, 'assignee_not_participant', ''))).toBe(
      'tickets.error.notParticipant',
    );
    expect(errorKey(new ApiError(404, 'not_found', ''))).toBe('tickets.error.gone');
    expect(errorKey(new ApiError(429, 'rate_limited', ''))).toBe('tickets.error.rateLimited');
    expect(errorKey(new Error('boom'))).toBe('tickets.error.generic');
  });
});
