import { describe, expect, it } from 'vitest';

import { fmtNum, pctLabel, periodInfo, rel, shortId, statusOf, toInput, usd } from './govFormat';

describe('govFormat', () => {
  it('formats amounts like the design (dot thousands, comma decimals)', () => {
    expect(fmtNum(1234567.5)).toBe('1.234.567,50');
    expect(usd('1250')).toBe('USD 1.250,00');
    expect(usd('0.4')).toBe('USD 0,40');
    expect(usd('abc')).toBe('abc');
    expect(toInput('150.5')).toBe('150,50');
  });

  it('never shows 100 % before the limit is really reached', () => {
    expect(pctLabel(99.7)).toBe('99 %');
    expect(pctLabel(100)).toBe('100 %');
    expect(statusOf(79.9)).toBe('ok');
    expect(statusOf(80)).toBe('warn');
    expect(statusOf(100)).toBe('out');
  });

  it('shortens user ids and formats relative times', () => {
    expect(shortId('a1b2c3d4e5-0000-1111')).toBe('a1b2c3d4');
    const t = (key: string, options: { n: number }) => `${key}:${String(options.n)}`;
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(rel('2026-09-30T11:59:40Z', t, now)).toBe('gov.rel.now:0');
    expect(rel('2026-09-30T11:30:00Z', t, now)).toBe('gov.rel.minutes:30');
    expect(rel('2026-09-30T09:00:00Z', t, now)).toBe('gov.rel.hours:3');
    expect(rel('2026-09-29T10:00:00Z', t, now)).toBe('gov.rel.yesterday:1');
    expect(rel('2026-09-26T10:00:00Z', t, now)).toBe('gov.rel.days:4');
  });

  it('describes the budget period in UTC, like the API (budget.current_period)', () => {
    // 1 Oct 03:00 UTC is still 30 Sep in Mexico (UTC-6): the API period is already October.
    const now = new Date('2026-10-01T03:00:00Z');
    expect(periodInfo('2026-10', now)).toEqual({ label: 'octubre de 2026', day: 1, days: 31 });
    expect(periodInfo('2026-02', new Date('2026-02-10T12:00:00Z'))).toMatchObject({ days: 28 });
    // An unexpected period falls back to the current UTC month.
    expect(periodInfo('bogus', now)).toMatchObject({ label: 'octubre de 2026', days: 31 });
  });
});
