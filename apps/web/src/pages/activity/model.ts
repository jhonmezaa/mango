import type { OperationOutput } from '../../api/operations';
import { csvCell } from '../../components/admin/auditModel';

// What the Actividad view derives from GET /api/activity (design activity.jsx, round 19
// «Disponible hoy», D90). The server decides whose activity each person reads and what an event
// of someone else carries (no conversation, task or run): nothing here decides authorization.

export type ActivityPage = OperationOutput<'getActivity'>;
export type ActivityEvent = ActivityPage['events'][number];
export type ActivityAgent = ActivityPage['agents'][number];
export type Kind = ActivityEvent['kind'];
export type Range = '1h' | '24h' | '7d';

export const RANGES: readonly { key: Range; ms: number }[] = [
  { key: '1h', ms: 3_600_000 },
  { key: '24h', ms: 86_400_000 },
  { key: '7d', ms: 7 * 86_400_000 },
];
/** Design: the kinds in the order of their chips (tickets and publications are not in this mode). */
export const KINDS: readonly Kind[] = ['tool', 'approval', 'budget', 'error'];
export const PAGE = 50;
/** Design round 19: «En vivo» asks every 15 s. */
export const LIVE_MS = 15_000;
/**
 * How far back the live mode asks. Someone else's turn reaches an administrator when it ends, each
 * call with its own time: a turn lasts at most 600 s (`AgentLimits.timeout_seconds`), so the
 * window covers the longest one, with a margin. Repeated events are dropped by id.
 */
export const LIVE_LOOKBACK_MS = 11 * 60_000;

const TASK_ID = /^[0-9a-f]{32}$/;
const RUN_ID = /^[0-9a-f]{32}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function rangeMs(range: Range): number {
  return RANGES.find((item) => item.key === range)?.ms ?? 86_400_000;
}

/** New events first, without repeating any already shown (the live mode asks a window). */
export function merge(current: ActivityEvent[], incoming: ActivityEvent[]): ActivityEvent[] {
  const seen = new Set(current.map((event) => event.id));
  const added = incoming.filter((event) => !seen.has(event.id));
  if (!added.length) return current;
  return [...added, ...current].sort((a, b) =>
    a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1,
  );
}

export function inRange(events: ActivityEvent[], range: Range, now: number): ActivityEvent[] {
  const since = now - rangeMs(range);
  return events.filter((event) => Date.parse(event.at) >= since);
}

export interface Link {
  kind: 'chat' | 'run' | 'approvals' | 'budgets';
  to: string;
}

/**
 * Where a row opens (design `linkOf`): the conversation or the run only from one's own events
 * (the API sends their ids only then), the approvals screen, and Presupuestos only for who may open
 * it. Ids are checked again before they become a route.
 */
export function linkOf(event: ActivityEvent, canSeeBudgets: boolean): Link | null {
  if (event.kind === 'approval') return { kind: 'approvals', to: '/approvals' };
  if (event.kind === 'budget') return canSeeBudgets ? { kind: 'budgets', to: '/budgets' } : null;
  if (!event.mine) return null;
  if (event.task_id && TASK_ID.test(event.task_id)) {
    return event.run_id && RUN_ID.test(event.run_id)
      ? { kind: 'run', to: `/schedules/${event.task_id}/run/${event.run_id}` }
      : { kind: 'run', to: `/schedules/${event.task_id}` };
  }
  if (event.conversation_id && CONVERSATION_ID.test(event.conversation_id)) {
    return { kind: 'chat', to: `/c/${encodeURIComponent(event.conversation_id)}` };
  }
  return null;
}

/** The line under a row (design `subOf`): only one's own task names it. */
export function subOf(event: ActivityEvent): string | null {
  return event.mine && event.task_name ? event.task_name : null;
}

export interface Stats {
  calls: number;
  errors: number;
  measured: number;
  avgMs: number | null;
  activeAgents: number;
  byAgent: { id: string; n: number; err: number }[];
}

/** KPIs and «agentes más activos» over the events of the period (design `ActivityView`). */
export function statsOf(events: ActivityEvent[]): Stats {
  let calls = 0;
  let errors = 0;
  let measured = 0;
  let totalMs = 0;
  const byAgent = new Map<string, { id: string; n: number; err: number }>();
  for (const event of events) {
    if (event.kind === 'tool' || event.kind === 'error') {
      calls += 1;
      if (event.ok === false) errors += 1;
      if (event.ms) {
        measured += 1;
        totalMs += event.ms;
      }
    }
    const line = byAgent.get(event.agent_id) ?? { id: event.agent_id, n: 0, err: 0 };
    line.n += 1;
    if (event.kind === 'error') line.err += 1;
    byAgent.set(event.agent_id, line);
  }
  return {
    calls,
    errors,
    measured,
    avgMs: measured ? Math.round(totalMs / measured) : null,
    activeAgents: byAgent.size,
    byAgent: [...byAgent.values()].sort((a, b) => b.n - a.n),
  };
}

/** Local start of the hour of a time, to group rows by hour. */
export function hourKey(iso: string): number {
  const date = new Date(iso);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

export function groupByHour(events: ActivityEvent[]): { key: number; items: ActivityEvent[] }[] {
  const groups: { key: number; items: ActivityEvent[] }[] = [];
  for (const event of events) {
    const key = hourKey(event.at);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(event);
    else groups.push({ key, items: [event] });
  }
  return groups;
}

/** Design `hourLabel`: «14:00 – 15:00», «Ayer · 14:00 – 15:00» or «22 oct · 14:00 – 15:00». */
export function hourLabel(key: number, now: number, yesterday: string): string {
  const date = new Date(key);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  const day =
    key >= start
      ? ''
      : key >= start - 86_400_000
        ? `${yesterday} · `
        : `${date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })} · `;
  const hour = (value: number) => `${String(value).padStart(2, '0')}:00`;
  return `${day}${hour(date.getHours())} – ${hour((date.getHours() + 1) % 24)}`;
}

/** Design: the time of a row, 24 h. */
export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Free-text search over what the row shows (design: agent, text, tool and its line). */
export function matches(event: ActivityEvent, needle: string, words: string): boolean {
  if (!needle) return true;
  return [words, event.tool ?? '', subOf(event) ?? ''].join(' ').toLowerCase().includes(needle);
}

export interface CsvRow {
  at: string;
  agent: string;
  kind: string;
  text: string;
  target: string;
  ms: number | null;
  ok: boolean | null;
}

/** Design `exportCsv`, with formula-safe cells (a spreadsheet must not run `=…`). */
export function toCsv(rows: CsvRow[]): string {
  const header = 'fecha,agente,tipo,evento,objetivo,ms,resultado';
  const lines = rows.map((row) =>
    [
      row.at,
      row.agent,
      row.kind,
      row.text,
      row.target,
      row.ms ?? '',
      row.ok === false ? 'error' : 'ok',
    ]
      .map(csvCell)
      .join(','),
  );
  return [header, ...lines].join('\n');
}
