import { describe, expect, it } from 'vitest';

import {
  groupByHour,
  hourLabel,
  inRange,
  linkOf,
  merge,
  statsOf,
  subOf,
  toCsv,
  type ActivityEvent,
} from './model';

const NOW = Date.parse('2026-10-24T12:30:00');

function event(overrides: Partial<ActivityEvent>): ActivityEvent {
  return {
    id: 'e1',
    kind: 'tool',
    agent_id: 'finops',
    at: new Date(NOW - 60_000).toISOString(),
    tool: 'get_cost_and_usage',
    ms: 100,
    ok: true,
    approval_id: null,
    approval_status: null,
    mine: true,
    conversation_id: 'c'.repeat(26),
    task_id: null,
    run_id: null,
    task_name: null,
    ...overrides,
  };
}

describe('activity model', () => {
  it('links the own conversation or run, never those of someone else', () => {
    expect(linkOf(event({}), false)?.to).toBe(`/c/${'c'.repeat(26)}`);
    const task = event({ conversation_id: null, task_id: 'a'.repeat(32), run_id: 'b'.repeat(32) });
    expect(linkOf(task, false)?.to).toBe(`/schedules/${'a'.repeat(32)}/run/${'b'.repeat(32)}`);
    expect(linkOf(event({ mine: false }), true)).toBeNull();
    // An id that is not one is never a route.
    expect(linkOf(event({ conversation_id: '../admin' }), false)).toBeNull();
    expect(linkOf(event({ kind: 'budget' }), false)).toBeNull();
    expect(linkOf(event({ kind: 'budget' }), true)?.to).toBe('/budgets');
    expect(linkOf(event({ kind: 'approval', mine: false }), false)?.to).toBe('/approvals');
  });

  it('names a task only on the own events', () => {
    expect(subOf(event({ task_name: 'Diaria' }))).toBe('Diaria');
    expect(subOf(event({ task_name: 'Diaria', mine: false }))).toBeNull();
  });

  it('merges new events without repeating any, newest first', () => {
    const old = event({ id: 'a', at: '2026-10-24T10:00:00.000Z' });
    const newer = event({ id: 'b', at: '2026-10-24T11:00:00.000Z' });
    const current = [old];
    expect(merge(current, [old])).toBe(current);
    expect(merge(current, [old, newer]).map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('counts calls, errors and the latency of the measured ones', () => {
    const stats = statsOf([
      event({ ms: 100 }),
      event({ kind: 'error', ok: false, ms: 300, agent_id: 'sec' }),
      event({ kind: 'approval', ms: null, ok: null }),
    ]);
    expect(stats).toMatchObject({ calls: 2, errors: 1, measured: 2, avgMs: 200, activeAgents: 2 });
    expect(stats.byAgent[0]).toEqual({ id: 'finops', n: 2, err: 0 });
  });

  it('keeps the period and groups by hour', () => {
    const recent = event({ at: new Date(NOW - 10 * 60_000).toISOString() });
    const old = event({ at: new Date(NOW - 2 * 3_600_000).toISOString() });
    expect(inRange([recent, old], '1h', NOW)).toEqual([recent]);
    expect(groupByHour([recent, old]).map((group) => group.items.length)).toEqual([1, 1]);
    const yesterday = new Date(NOW - 86_400_000);
    yesterday.setMinutes(0, 0, 0);
    expect(hourLabel(yesterday.getTime(), NOW, 'Ayer')).toBe('Ayer · 12:00 – 13:00');
  });

  it('exports formula-safe CSV', () => {
    const csv = toCsv([
      { at: 'x', agent: '=HYPERLINK("a")', kind: 'k', text: 't', target: '', ms: null, ok: false },
    ]);
    expect(csv.split('\n')[1]).toBe(`"x","'=HYPERLINK(""a"")","k","t","","","error"`);
  });
});
