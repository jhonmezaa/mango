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
 * The scope to expect before the answer arrives, for the subtitle while it loads (design round
 * 28). UX only: the API decides the scope with Cedar on every request (REACT-AUTHZ-001), and its
 * answer replaces this one.
 */
export function expectedScope(me: Pick<Me, 'is_admin' | 'role' | 'business_unit'>): Home['scope'] {
  if (me.is_admin || me.role === 'finops-central') return 'org';
  return me.role === 'bu-lead' && me.business_unit ? 'area' : 'mine';
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
  /** One value per point; `null` where nothing was counted yet: neither added up nor drawn. */
  cur: (number | null)[];
  prev: (number | null)[];
  /** `yyyy-mm-dd` of each point: the day, or the first day of the week. */
  dates: string[];
  prevDates: string[];
  /** Whether every day behind the points was counted. */
  curWhole: boolean;
  prevWhole: boolean;
}

/** Weeks end today: the oldest days that do not fill a week are left out, as the design's. */
function pointsOf(length: number, step: number): { n: number; start: number } {
  const n = Math.max(1, Math.floor(length / step));
  return { n, start: length - n * step };
}

function bucket(values: readonly (number | null)[], step: number): (number | null)[] {
  if (step === 1) return [...values];
  const { n, start } = pointsOf(values.length, step);
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i += 1) {
    // A week counted only in part adds up those days; one with none of them has no value.
    let total: number | null = null;
    for (let j = start + i * step; j < start + (i + 1) * step; j += 1) {
      const value = values[j] ?? null;
      if (value !== null) total = (total ?? 0) + value;
    }
    out.push(total);
  }
  return out;
}

function bucketDates(days: readonly HomeDay[], step: number): string[] {
  if (step === 1) return days.map((d) => d.day);
  const { n, start } = pointsOf(days.length, step);
  return Array.from({ length: n }, (_, i) => days[start + i * step]?.day ?? '');
}

function isWhole(values: readonly (number | null)[], step: number): boolean {
  return values
    .slice(Math.max(0, pointsOf(values.length, step).start))
    .every((value) => value !== null);
}

/** Design: weekly over 7 days is daily (`gran === 'week' && period === '7d' ? 'day'`). */
export function effectiveGranularity(period: Period, gran: Granularity): Granularity {
  return gran === 'week' && period === '7d' ? 'day' : gran;
}

/**
 * The series of a card. The API answers 0 for a day without a counter; before `counted_since`
 * that is not a zero but a day Mango did not count (design round 28, `dashSince`), and with no
 * `counted_since` no day was counted yet.
 */
export function seriesOf(
  data: Pick<Home, 'days' | 'previous' | 'counted_since'>,
  pick: (day: HomeDay) => number,
  gran: Granularity,
): Series {
  const step = gran === 'week' ? 7 : 1;
  const since = data.counted_since;
  const read = (days: readonly HomeDay[]) =>
    days.map((day) => (since !== null && day.day >= since ? pick(day) : null));
  const cur = read(data.days);
  const prev = read(data.previous);
  return {
    cur: bucket(cur, step),
    prev: bucket(prev, step),
    dates: bucketDates(data.days, step),
    prevDates: bucketDates(data.previous, step),
    curWhole: isWhole(cur, step),
    prevWhole: isWhole(prev, step),
  };
}

export const spentOf = (day: HomeDay): number => {
  const value = Number(day.spent_usd);
  return Number.isFinite(value) ? value : 0;
};
export const turnsOf = (day: HomeDay): number => day.turns;

/** The values that were counted. */
export function countedOf(values: readonly (number | null)[]): number[] {
  return values.filter((value) => value !== null);
}

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

/** "29 sep 2026" (design `fmtDate`), read as the UTC day the API sends. */
export function fmtDate(day: string): string {
  return `${fmtDay(day)} ${day.slice(0, 4)}`;
}

/** The whole minutes and hours behind «Actualizado» (design `dashAgo`). */
export function agoOf(ms: number): { unit: 'seconds' | 'minutes' | 'hours'; count: number } {
  const seconds = ms / 1000;
  if (seconds < 60) return { unit: 'seconds', count: 0 };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  return { unit: 'hours', count: Math.floor(minutes / 60) };
}

/** Design `niceMax`: the top of the axis. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(value));
  const m = value / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

export interface Axis {
  max: number;
  ticks: number[];
  /** Decimals of its labels: 0 is the design's format. */
  decimals: number;
}

const EPSILON = 1e-9;
const isMultiple = (value: number, unit: number) => {
  const units = value / unit;
  return Math.abs(units - Math.round(units)) < EPSILON;
};

/** The marks a label can show: USD with cents below 10, whole numbers otherwise. */
function exact(value: number, money: boolean, top: number): boolean {
  return isMultiple(value, money && top < 10 ? 0.01 : 1);
}

/** The smallest step of 1, 2 or 5 that draws `top` in five parts at most. */
function niceStep(top: number, money: boolean): number {
  const least = money ? top / 5 : Math.max(1, top / 5);
  const p = 10 ** Math.floor(Math.log10(least) + EPSILON);
  const multiple = [1, 2, 5].find((m) => m * p >= least - EPSILON) ?? 10;
  return multiple * p;
}

function decimalsOf(step: number): number {
  if (step >= 1) return 0;
  let decimals = 2;
  while (decimals < 6 && !isMultiple(step, 10 ** -decimals)) decimals += 1;
  return decimals;
}

/**
 * The axis up to `peak`. Design: `niceMax` in four parts. Where a label would have to round those
 * marks (the design's repeat with a maximum of 1: «USD 1, 1, 1, 0, 0»), a step every label can
 * show, and the top moves to its next mark.
 */
export function axisOf(peak: number, money: boolean): Axis {
  const top = niceMax(peak);
  const quarter = top / 4;
  const step = exact(quarter, money, top) ? quarter : niceStep(top, money);
  const parts = Math.ceil(top / step - EPSILON);
  return {
    max: parts * step,
    ticks: Array.from({ length: parts + 1 }, (_, i) => i * step),
    decimals: decimalsOf(step),
  };
}

/** Design `fmtCompact`: axis labels; `decimals` for the marks below one unit. */
export function fmtCompact(value: number, money: boolean, decimals = 0): string {
  const prefix = money ? 'USD ' : '';
  if (decimals > 0 && value > 0) {
    return `${prefix}${value.toLocaleString('es-ES', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
  }
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
 * The CSV of a card (design «Exportar»): day, value and the same day of the period before; a
 * day that was not counted has no value, not a zero.
 * Only dates and numbers the API sent: nothing a spreadsheet would run as a formula.
 */
export function toCsv(series: Series, header: string): string {
  const rows = series.dates.map(
    (day, i) =>
      `${day},${String(series.cur[i] ?? '')},${series.prevDates[i] ?? ''},${String(series.prev[i] ?? '')}`,
  );
  return [`fecha,${header},fecha_anterior,${header}_anterior`, ...rows].join('\n');
}
