import type { OperationOutput } from '../../api/operations';
import { csvCell } from '../../components/admin/auditModel';

// Costos (design round 37, costs2.jsx; D105–D107): what the view computes from GET /api/costs.
// Every figure comes from the server's day counters; nothing here estimates or spreads spend.

export type Costs = OperationOutput<'getCosts'>;
export type AgentCost = Costs['agents']['rows'][number];
export type Group = 'agent' | 'model' | 'source';

export const GROUPS: readonly Group[] = ['agent', 'model', 'source'];
/** The design's order of «Por origen»: Conversaciones, Schedules, Evals, Playground. */
export const SOURCES = ['chat', 'task', 'eval', 'playground'] as const;
export const PLAYGROUND = 'playground';
/** «Cambios frente al mes anterior»: the four agents whose spend moved the most. */
const MOVERS = 4;

/**
 * A line of the breakdown table. `none` is what no row holds once the counters count (the
 * titles of new conversations), `pre` what was spent before they started: both grey, never
 * spread over the rows, and without «vs anterior». `aside` is an agent row that is not an agent
 * of the catalog (the Playground, an agent no longer there): grey and at the end too (round 38).
 */
export interface Line {
  key: string;
  kind: 'row' | 'aside' | 'none' | 'pre';
  id: string;
  spent: number;
  /** The month before; null when the breakdown did not count all of it. */
  previous: number | null;
  /** Rows that open the agent's drawer. */
  open: boolean;
}

export const num = (value: string | null | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The breakdown counted the whole month before (`counted_since` on or before its first day). */
export function coversPrevious(since: string | null, data: Pick<Costs, 'previous_month'>): boolean {
  return since !== null && since <= `${data.previous_month}-01`;
}

/** The breakdown counted the whole month. */
export function coversMonth(since: string | null, data: Pick<Costs, 'month'>): boolean {
  return since !== null && since <= `${data.month}-01`;
}

function breakdownOf(data: Costs, group: Group): Costs['models'] {
  if (group === 'agent') return data.agents;
  return group === 'model' ? data.models : data.sources;
}

export function sinceOf(data: Costs, group: Group): string | null {
  return breakdownOf(data, group).counted_since;
}

/** The lines of a breakdown, as the design: rows by spend, then the grey ones. */
export function linesOf(data: Costs, group: Group): Line[] {
  const breakdown = breakdownOf(data, group);
  const withPrevious = coversPrevious(breakdown.counted_since, data);
  const rows: Line[] = (
    group === 'source'
      ? SOURCES.flatMap((id) => data.sources.rows.filter((row) => row.id === id))
      : breakdown.rows
  ).map((row): Line => {
    const aside = group === 'agent' && isAside(row as AgentCost);
    return {
      key: `row:${row.id}`,
      kind: aside ? 'aside' : 'row',
      id: row.id,
      spent: num(row.spent_usd),
      previous: withPrevious && !aside ? num(row.previous_usd) : null,
      open: group === 'agent' && !aside,
    };
  });
  const before = num(breakdown.before_since_usd);
  const none = Math.max(0, num(breakdown.unattributed_usd) - before);
  const grey: Line[] = [
    { key: 'none', kind: 'none', id: 'none', spent: none, previous: null, open: false },
    { key: 'pre', kind: 'pre', id: 'pre', spent: before, previous: null, open: false },
  ];
  return [
    ...rows
      .filter((line) => line.spent > 0)
      // Design round 38: the grey rows go last, like «Sin agente» (`flat` sorts after the rest).
      .sort((a, b) => Number(a.kind === 'aside') - Number(b.kind === 'aside') || b.spent - a.spent),
    // Design: «Sin agente» stays even at zero; the other grey lines only when they hold spend.
    ...grey.filter((line) => line.spent > 0 || (group === 'agent' && line.kind === 'none')),
  ];
}

/** The Playground's row, or an agent the catalog no longer has (no name). */
export function isAside(row: Pick<AgentCost, 'id' | 'name'>): boolean {
  return row.id === PLAYGROUND || row.name === null;
}

export interface Mover {
  row: AgentCost;
  delta: number;
}

/** null when the month before has no breakdown per agent (the design's note instead). */
export function moversOf(data: Costs): Mover[] | null {
  if (!coversPrevious(data.agents.counted_since, data)) return null;
  return data.agents.rows
    .filter((row) => num(row.previous_usd) > 0)
    .map((row) => ({ row, delta: num(row.spent_usd) - num(row.previous_usd) }))
    .filter((mover) => mover.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MOVERS);
}

/** The running total of each day. */
export function cumulative(days: readonly { spent_usd: string }[]): number[] {
  let total = 0;
  return days.map((day) => (total += num(day.spent_usd)));
}

/** Percent change, or null when there is nothing to compare with. */
export function change(spent: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null;
  return ((spent - previous) / previous) * 100;
}

export interface CsvLabels {
  header: string;
  noAgent: string;
  pre: string;
  noBreakdown: string;
  nameOf: (row: AgentCost) => string;
}

/**
 * The design's CSV: `agente, modelo, gasto_mes, mes_anterior, consultas`, with «Sin agente» and
 * «Sin desglose». Every cell goes through `csvCell`: an agent's name is written by a creator, so
 * a leading `=`, `+`, `-`, `@`, tab or return is neutralized (TM-C5).
 */
export function toCsv(data: Costs, labels: CsvLabels): string {
  const withPrevious = coversPrevious(data.agents.counted_since, data);
  const before = num(data.agents.before_since_usd);
  const none = Math.max(0, num(data.agents.unattributed_usd) - before);
  const lines: unknown[][] = [
    ...data.agents.rows.map((row) => [
      labels.nameOf(row),
      row.model ?? '',
      row.spent_usd,
      withPrevious ? row.previous_usd : labels.noBreakdown,
      row.turns,
    ]),
    [labels.noAgent, '', none.toFixed(2), labels.noBreakdown, ''],
    ...(before > 0 ? [[labels.pre, '', before.toFixed(2), '', '']] : []),
  ];
  return [labels.header, ...lines.map((cells) => cells.map(csvCell).join(','))].join('\n');
}

const SHORT_DATE = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const MONTH = new Intl.DateTimeFormat('es-MX', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

function utc(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date));
}

/** «5 oct 2026» from a counter's `yyyy-mm-dd` (UTC). */
export function formatDay(day: string): string {
  return SHORT_DATE.format(utc(day));
}

/** «noviembre de 2026» from `yyyy-mm`. */
export function formatMonth(month: string): string {
  return MONTH.format(utc(`${month}-01`));
}

const SHARE = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const THOUSANDS = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const COUNT = new Intl.NumberFormat('es-ES', { useGrouping: 'always' });

export const formatShare = (value: number): string => SHARE.format(value);
export const formatCount = (value: number): string => COUNT.format(value);

/** «USD 1.234,50»: two decimals, always grouped, as the design's `GovKit.usd`. */
export function money(value: number): string {
  const [whole = '0', cents = '00'] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '-' : ''}USD ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
}

/** «USD 12,3k» from a thousand up, as the design's `kmoney`. */
export function kmoney(value: number): string {
  return value >= 1000 ? `USD ${THOUSANDS.format(value / 1000)}k` : money(value);
}
