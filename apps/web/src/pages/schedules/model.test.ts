import { describe, expect, it } from 'vitest';

import {
  cronOf,
  healthOf,
  matchesQuick,
  monthlyEstimate,
  perMonth,
  permsOf,
  startedToday,
} from './model';
import { run, task } from './testFixtures';

describe('schedules model', () => {
  it('shows the cron of the design for each frequency', () => {
    const base = { hour: 9, minute: 0, days: [1, 4], dow: 1, dom: 1 };
    expect(cronOf({ ...base, freq: '15m' })).toBe('*/15 * * * *');
    expect(cronOf({ ...base, freq: 'weekdays' })).toBe('0 9 * * 1-5');
    expect(cronOf({ ...base, freq: 'days' })).toBe('0 9 * * 1,4');
    expect(cronOf({ ...base, freq: 'monthly' })).toBe('0 9 1 * *');
    expect(perMonth({ ...base, freq: 'days' })).toBeCloseTo(8.6);
  });

  it('estimates a month: average cost by schedule, last 30 days on anomalies (design)', () => {
    const daily = task({ runs: [run({ cost_usd: '0.10' }), run({ cost_usd: '0.30' })] });
    const paused = task({ status: 'paused' });
    const event = task({
      trigger: {
        kind: 'event',
        schedule: null,
        timezone: null,
        event_type: 'cost_anomaly',
        daily_cap: 5,
      },
    });
    const now = new Date('2026-10-16T00:00:00Z').getTime();
    // 0,20 × 30 runs a month, plus the 0,08 the anomaly task cost in the last 30 days.
    expect(monthlyEstimate([daily, paused, event], now)).toBeCloseTo(6.08);
    const later = new Date('2026-12-16T00:00:00Z').getTime();
    expect(monthlyEstimate([event], later)).toBe(0);
  });

  it('needs attention when the API or the tools say so, never when retired', () => {
    expect(healthOf(task(), [])).toBeNull();
    expect(healthOf(task(), ['cost-explorer.x'])?.key).toBe('tools');
    expect(healthOf(task({ health: { tone: 'red', code: 'failing' } }), [])?.key).toBe('failing');
    expect(
      healthOf(task({ status: 'retired', health: { tone: 'red', code: 'failing' } }), []),
    ).toBeNull();
    expect(matchesQuick(task({ status: 'retired' }), 'all', null)).toBe(false);
    expect(matchesQuick(task({ status: 'retired' }), 'retired', null)).toBe(true);
  });

  it('decides the buttons as the design does (scPerms)', () => {
    const adminPaused = task({ status: 'paused', paused_reason: 'admin', is_owner: false });
    expect(permsOf(adminPaused, true)).toMatchObject({ canResume: true, canPause: false });
    const ownerPaused = task({ status: 'paused', paused_reason: 'owner', is_owner: false });
    expect(permsOf(ownerPaused, true)).toMatchObject({ canResume: false, canPause: true });
    const mineByAdmin = task({ status: 'paused', paused_reason: 'admin' });
    expect(permsOf(mineByAdmin, false)).toMatchObject({ canRun: false, canResume: false });
    const lost = task({ status: 'paused', paused_reason: 'access_lost' });
    expect(permsOf(lost, true)).toMatchObject({ canRun: false, canResume: false, canPause: false });
  });

  it('counts the runs that started today (UTC) for the daily cap, not the skipped ones', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const today = task({
      runs: [
        run({ started_at: '2026-10-16T01:00:00Z' }),
        run({ status: 'skipped', started_at: null, queued_at: '2026-10-16T02:00:00Z' }),
        run({ started_at: '2026-10-15T23:00:00Z' }),
      ],
    });
    expect(startedToday(today, now)).toBe(1);
  });
});
