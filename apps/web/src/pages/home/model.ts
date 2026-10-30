import type { OperationOutput } from '../../api/operations';
import type { Me } from '../../api/schemas';
import { readPreference, writePreference } from '../../preferences/storage';

// What Inicio derives from GET /api/home (design dashboard.jsx + charts.jsx, D102). The server
// decides whose numbers they are (organization, area or the caller's own) and nothing here
// decides authorization. Weekly granularity and the comparison are presentation only.

export type Home = OperationOutput<'getHome'>;
export type HomeDay = Home['days'][number];
export type HomeBudget = Home['budgets'][number];

export type Period = Home['period'];
export type Granularity = 'day' | 'week';

export const PERIODS: readonly Period[] = ['7d', '30d', '90d', '180d'];
export const DEFAULT_PERIOD: Period = '30d';

/**
 * D102 and the owner's choice of 2026-10-29: Inicio shows data to whoever sees the organization
 * (administrators and central FinOps) until the design draws the area and personal variants.
 * UX only: the API decides the scope with Cedar on every request (REACT-AUTHZ-001).
 */
export function seesOrganization(me: Pick<Me, 'is_admin' | 'role'>): boolean {
  return me.is_admin || me.role === 'finops-central';
}

function isPeriod(value: string | null): value is Period {
  return value !== null && (PERIODS as readonly string[]).includes(value);
}

/** The saved period (design `mango-dash-period`); anything else is the default. */
export function savedPeriod(): Period {
  const value = readPreference('mango-dash-period');
  return isPeriod(value) ? value : DEFAULT_PERIOD;
}

export function savePeriod(period: Period): void {
  writePreference('mango-dash-period', period);
}

export interface Series {
  cur: number[];
  prev: number[];
  /** `yyyy-mm-dd` of each point: the day, or the first day of the week. */
  dates: string[];
  prevDates: string[];
}

function bucket(values: number[], step: number): number[] {
  if (step === 1) return values;
  const out: number[] = [];
  // Weeks end today: the oldest bucket may be shorter, as the design's (`floor(days / 7)`).
  const n = Math.max(1, Math.floor(values.length / step));
  const start = values.length - n * step;
  for (let i = 0; i < n; i += 1) {
    let total = 0;
    for (let j = start + i * step; j < start + (i + 1) * step; j += 1) total += values[j] ?? 0;
    out.push(total);
  }
  return out;
}

function bucketDates(days: readonly HomeDay[], step: number): string[] {
  if (step === 1) return days.map((d) => d.day);
  const n = Math.max(1, Math.floor(days.length / step));
  const start = days.length - n * step;
  return Array.from({ length: n }, (_, i) => days[start + i * step]?.day ?? '');
}

/** Design: weekly over 7 days is daily (`gran === 'week' && period === '7d' ? 'day'`). */
export function effectiveGranularity(period: Period, gran: Granularity): Granularity {
  return gran === 'week' && period === '7d' ? 'day' : gran;
}

export function seriesOf(
  data: Pick<Home, 'days' | 'previous'>,
  pick: (day: HomeDay) => number,
  gran: Granularity,
): Series {
  const step = gran === 'week' ? 7 : 1;
  return {
    cur: bucket(data.days.map(pick), step),
    prev: bucket(data.previous.map(pick), step),
    dates: bucketDates(data.days, step),
    prevDates: bucketDates(data.previous, step),
  };
}

export const spentOf = (day: HomeDay): number => {
  const value = Number(day.spent_usd);
  return Number.isFinite(value) ? value : 0;
};
export const turnsOf = (day: HomeDay): number => day.turns;

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** Change against the period before, in percent; 0 without a period before (design). */
export function deltaOf(total: number, previous: number): number {
  return previous ? ((total - previous) / previous) * 100 : 0;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "29 sep" (design `fmtDay`), read as the UTC day the API sends. */
export function fmtDay(day: string): string {
  const [, month, date] = day.split('-').map(Number);
  if (!month || !date) return day;
  return `${String(date)} ${MONTHS[month - 1] ?? ''}`;
}

/** Design `niceMax`: the top of the axis. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(value));
  const m = value / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

/** Design `fmtCompact`: axis labels. */
export function fmtCompact(value: number, money: boolean): string {
  const prefix = money ? 'USD ' : '';
  if (value >= 1e6) return `${prefix}${(value / 1e6).toFixed(1).replace('.0', '')}M`;
  if (value >= 1e3)
    return `${prefix}${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1).replace('.0', '')}K`;
  return `${prefix}${String(Math.round(value))}`;
}

/** Percent of a budget used (design `Math.round(spent / limit * 100)`). */
export function budgetPercent(budget: HomeBudget): number {
  const spent = Number(budget.spent_usd);
  const limit = Number(budget.limit_usd);
  if (!Number.isFinite(spent) || !Number.isFinite(limit) || limit <= 0) return spent > 0 ? 100 : 0;
  return Math.round((spent / limit) * 100);
}

/**
 * The CSV of a card (design «Exportar»): day, value and the same day of the period before.
 * Only dates and numbers the API sent: nothing a spreadsheet would run as a formula.
 */
export function toCsv(series: Series, header: string): string {
  const rows = series.dates.map(
    (day, i) =>
      `${day},${String(series.cur[i] ?? 0)},${series.prevDates[i] ?? ''},${String(series.prev[i] ?? 0)}`,
  );
  return [`fecha,${header},fecha_anterior,${header}_anterior`, ...rows].join('\n');
}
