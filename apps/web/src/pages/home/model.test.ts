import { afterEach, describe, expect, it } from 'vitest';

import {
  agoOf,
  axisOf,
  axisWidth,
  budgetPercent,
  countedOf,
  deltaOf,
  effectiveGranularity,
  expectedScope,
  fmtCompact,
  fmtDate,
  fmtDay,
  niceMax,
  savedPeriod,
  savePeriod,
  seriesOf,
  spentOf,
  toCsv,
  turnsOf,
  type Home,
} from './model';

function days(count: number, from: string, turns = (i: number) => i + 1) {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    spent_usd: (turns(i) / 10).toFixed(6),
    turns: turns(i),
  }));
}

afterEach(() => {
  localStorage.clear();
});

describe('home model', () => {
  it('expects the scope the server will answer for each account', () => {
    const scope = (is_admin: boolean, role: 'finops-central' | 'bu-lead' | null, unit = 'ops') =>
      expectedScope({ is_admin, role, business_unit: unit });
    expect(scope(true, null)).toBe('org');
    expect(scope(false, 'finops-central')).toBe('org');
    expect(scope(false, 'bu-lead')).toBe('area');
    expect(scope(false, 'bu-lead', '')).toBe('mine');
    expect(scope(false, null)).toBe('mine');
  });

  it('keeps the period as a UI preference and ignores anything else', () => {
    expect(savedPeriod()).toBe('30d');
    savePeriod('90d');
    expect(savedPeriod()).toBe('90d');
    localStorage.setItem('mango-dash-period', '9999d');
    expect(savedPeriod()).toBe('30d');
  });

  it('builds the daily series and adds up whole weeks ending today', () => {
    const data: Pick<Home, 'days' | 'previous' | 'counted_since'> = {
      days: days(30, '2026-10-01'),
      previous: days(30, '2026-09-01', () => 1),
      counted_since: '2026-01-01',
    };
    const daily = seriesOf(data, turnsOf, 'day');
    expect(daily.cur).toHaveLength(30);
    expect(daily.dates[29]).toBe('2026-10-30');
    const weekly = seriesOf(data, turnsOf, 'week');
    // Four weeks: days 3..30; the two oldest days are left out, as the design's floor(30 / 7).
    expect(weekly.cur).toHaveLength(4);
    expect(weekly.cur[0]).toBe(3 + 4 + 5 + 6 + 7 + 8 + 9);
    expect(weekly.cur[3]).toBe(24 + 25 + 26 + 27 + 28 + 29 + 30);
    expect(weekly.dates).toEqual(['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24']);
    expect(weekly.prev).toEqual([7, 7, 7, 7]);
    expect(seriesOf(data, spentOf, 'day').cur[0]).toBeCloseTo(0.1);
  });

  it('has no value for the days before the counter started', () => {
    const series = seriesOf(
      {
        days: days(4, '2026-10-01'),
        previous: days(4, '2026-09-27'),
        counted_since: '2026-10-03',
      },
      turnsOf,
      'day',
    );
    expect(series.cur).toEqual([null, null, 3, 4]);
    expect(series.prev).toEqual([null, null, null, null]);
    expect(series.curWhole).toBe(false);
    expect(series.prevWhole).toBe(false);
    expect(countedOf(series.cur)).toEqual([3, 4]);
  });

  it('counts nothing before the first turn', () => {
    const series = seriesOf(
      { days: days(2, '2026-10-01'), previous: days(2, '2026-09-29'), counted_since: null },
      turnsOf,
      'day',
    );
    expect(series.cur).toEqual([null, null]);
    expect(series.curWhole).toBe(false);
  });

  it('adds up the counted days of a week and says the week is not whole', () => {
    const series = seriesOf(
      {
        days: days(14, '2026-10-01', () => 1),
        previous: days(14, '2026-09-17', () => 1),
        counted_since: '2026-10-06',
      },
      turnsOf,
      'week',
    );
    // Days 1-7 of October, counted from the 6th, and all of the second week.
    expect(series.cur).toEqual([2, 7]);
    expect(series.curWhole).toBe(false);
    expect(series.prev).toEqual([null, null]);
  });

  it('ignores the days a week does not reach when it says a series is whole', () => {
    const series = seriesOf(
      {
        days: days(30, '2026-10-01', () => 1),
        previous: days(30, '2026-09-01', () => 1),
        counted_since: '2026-09-03',
      },
      turnsOf,
      'week',
    );
    // The two oldest days of the period before are not in any week.
    expect(series.prevWhole).toBe(true);
    expect(
      seriesOf({ ...{ days: [], previous: [] }, counted_since: null }, turnsOf, 'day').cur,
    ).toEqual([]);
  });

  it('shows weekly over seven days as daily', () => {
    expect(effectiveGranularity('7d', 'week')).toBe('day');
    expect(effectiveGranularity('30d', 'week')).toBe('week');
  });

  it('formats as the design', () => {
    expect(fmtDay('2026-09-29')).toBe('29 sep');
    expect(fmtDate('2026-09-29')).toBe('29 sep 2026');
    expect(niceMax(0)).toBe(1);
    expect(niceMax(370)).toBe(500);
    expect(fmtCompact(12_500, true)).toBe('USD 13K');
    expect(fmtCompact(1500, false)).toBe('1.5K');
    expect(deltaOf(150, 100)).toBe(50);
    expect(deltaOf(5, 0)).toBe(0);
  });

  const labels = (peak: number, money: boolean) => {
    const axis = axisOf(peak, money);
    return axis.ticks.map((tick) => fmtCompact(tick, money, axis.decimals));
  };

  it('keeps the four parts of the design where the labels show them', () => {
    expect(axisOf(370, true)).toEqual({ max: 500, ticks: [0, 125, 250, 375, 500], decimals: 0 });
    expect(labels(80, false)).toEqual(['0', '25', '50', '75', '100']);
    expect(labels(0, true)).toEqual(['USD 0', 'USD 0,25', 'USD 0,50', 'USD 0,75', 'USD 1,00']);
  });

  it('labels small amounts with distinct marks that say their value', () => {
    expect(labels(0.0315, true)).toEqual([
      'USD 0',
      'USD 0,01',
      'USD 0,02',
      'USD 0,03',
      'USD 0,04',
      'USD 0,05',
    ]);
    expect(labels(0.0042, true)).toEqual([
      'USD 0',
      'USD 0,001',
      'USD 0,002',
      'USD 0,003',
      'USD 0,004',
      'USD 0,005',
    ]);
    expect(labels(2.1, true)).toEqual([
      'USD 0',
      'USD 0,50',
      'USD 1,00',
      'USD 1,50',
      'USD 2,00',
      'USD 2,50',
    ]);
  });

  it('drops the zeros a step below one cent does not need, as the design', () => {
    expect(labels(0.00051, true)).toEqual([
      'USD 0',
      'USD 0,0002',
      'USD 0,0004',
      'USD 0,0006',
      'USD 0,0008',
      'USD 0,001',
    ]);
    expect(labels(0.0000003, true)).toEqual([
      'USD 0',
      'USD 0,0000001',
      'USD 0,0000002',
      'USD 0,0000003',
      'USD 0,0000004',
      'USD 0,0000005',
    ]);
  });

  it('sizes the axis column by its longest label, 48 px at least', () => {
    expect(axisWidth(['0', '25', '100'])).toBe(48);
    expect(axisWidth(['USD 0', 'USD 2,50'])).toBe(61);
    expect(axisWidth(['USD 0', 'USD 0,0002'])).toBe(74);
  });

  it('says the cents of a step above one dollar instead of rounding the mark', () => {
    expect(labels(3, true)).toEqual(['USD 0', 'USD 1,25', 'USD 2,50', 'USD 3,75', 'USD 5,00']);
  });

  it('counts in whole numbers and keeps the top above the peak', () => {
    expect(labels(0, false)).toEqual(['0', '1']);
    expect(labels(1.05, false)).toEqual(['0', '1', '2']);
    expect(labels(2.1, false)).toEqual(['0', '1', '2', '3']);
    expect(labels(4.2, false)).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(labels(9, false)).toEqual(['0', '2', '4', '6', '8', '10']);
    expect(axisOf(2.1, false).max).toBe(3);
  });

  it('never repeats a mark', () => {
    for (const money of [true, false]) {
      for (const peak of [0, 0.0004, 0.03, 0.07, 0.4, 1, 3, 7, 12, 24, 60, 240, 900, 2400, 9000]) {
        const shown = labels(peak, money);
        expect(new Set(shown).size).toBe(shown.length);
        expect(axisOf(peak, money).max).toBeGreaterThanOrEqual(peak);
      }
    }
  });

  it('reads how long ago the answer came, in whole units', () => {
    expect(agoOf(59_000)).toEqual({ unit: 'seconds', count: 0 });
    expect(agoOf(60_000)).toEqual({ unit: 'minutes', count: 1 });
    expect(agoOf(59 * 60_000)).toEqual({ unit: 'minutes', count: 59 });
    expect(agoOf(2 * 3_600_000)).toEqual({ unit: 'hours', count: 2 });
  });

  it('computes the budget percent without dividing by zero', () => {
    const budget = { scope: 'agent' as const, id: 'finops', name: null, limit_usd: '200.00' };
    expect(budgetPercent({ ...budget, spent_usd: '170.00' })).toBe(85);
    expect(budgetPercent({ ...budget, spent_usd: '1.00', limit_usd: '0.00' })).toBe(100);
  });

  it('exports dates and numbers only', () => {
    const csv = toCsv(
      {
        cur: [1, 2],
        prev: [null, 3],
        dates: ['2026-10-01', '2026-10-02'],
        prevDates: ['2026-09-29', '2026-09-30'],
        curWhole: true,
        prevWhole: false,
      },
      'invocaciones',
    );
    expect(csv.split('\n')).toEqual([
      'fecha,invocaciones,fecha_anterior,invocaciones_anterior',
      '2026-10-01,1,2026-09-29,',
      '2026-10-02,2,2026-09-30,3',
    ]);
  });
});
