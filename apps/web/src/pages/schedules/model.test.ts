import { describe, expect, it } from 'vitest';

import { cronOf, healthOf, matchesQuick, monthlyEstimate, perMonth } from './model';
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

  it('estimates a month from the average cost of active scheduled tasks only', () => {
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
    expect(monthlyEstimate([daily, paused, event])).toBeCloseTo(6);
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
});
