import type { OperationInput, OperationOutput } from '../../api/operations';

// Observability (design round 37, observability2.jsx): the helpers of the view over
// GET /api/observability. The server reads, joins, filters and pages the traces; here they are
// only formatted. Every value is rendered as text.

export type Reading = OperationOutput<'getObservability'>;
export type Trace = Reading['traces'][number];
export type Span = Trace['spans'][number];
export type Range = NonNullable<NonNullable<OperationInput<'getObservability'>['query']>['range']>;
export type StatusFilter = NonNullable<
  NonNullable<OperationInput<'getObservability'>['query']>['status']
>;

export const RANGES: readonly Range[] = ['1h', '6h', '24h'];
export const STATUSES: readonly StatusFilter[] = ['all', 'error', 'slow'];
/** The page the API answers by default (`observability.PAGE`). */
export const PAGE = 40;
/** «tools más lentas o con fallas» lists eight (design `toolStats.slice(0, 8)`). */
export const TOP_TOOLS = 8;
/** «latencia por agente · p95» lists eight (design `byAgent.slice(0, 8)`). */
export const TOP_AGENTS = 8;
/** Debounce of the search, so typing does not spend the 30 readings a minute. */
export const SEARCH_DEBOUNCE_MS = 350;

/** Design `obsShort`: the first eight characters of the view's id, in mono. */
export const shortId = (id: string) => id.slice(0, 8);

/** Design `obsMs`: «820 ms» below a second, else «4,2 s» (one decimal at most). */
export function formatMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} s`;
  }
  return `${String(Math.round(ms))} ms`;
}

/** «12,5» from the API's «12.5». */
export const percentText = (value: string) => value.replace('.', ',');

/** «1.234» (es-ES groups four digits too, as the design's `useGrouping: 'always'`). */
export const intText = (value: number) => value.toLocaleString('es-ES', { useGrouping: 'always' });

/** Design: thousands of tokens without decimals («7 k tokens»). */
export const kTokens = (tokens: number) =>
  (tokens / 1e3).toLocaleString('es-ES', { maximumFractionDigits: 0 });

/** «14:05» of a row (design `toLocaleTimeString('es-MX', …)`). */
export const timeText = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });

/** The drawer's date (design `toLocaleString('es-MX', { dateStyle: 'medium', … })`). */
export const dateText = (iso: string) =>
  new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

export type TraceKind = 'chat' | 'task' | 'playground' | 'unmatched';

/**
 * What the row says the trace was (design «Conversación de {correo}» / «Tarea de {correo}»).
 * A test of the Playground and a trace without a turn of Mango have texts of their own (decided
 * on 2026-11-05 for round 38).
 */
export function kindOf(trace: Trace): TraceKind {
  if (!trace.matched) return 'unmatched';
  if (trace.playground || trace.origin === 'playground') return 'playground';
  return trace.origin === 'task' ? 'task' : 'chat';
}

/** The person of a trace: the email, or the id when the directory did not give one. */
export const whoOf = (trace: Trace) => trace.user_email ?? trace.user_id ?? '';

/** Where a span sits in the waterfall, in % of the trace (design `ob-span-bar`). */
export function spanBar(span: Span, total: number): { left: number; width: number } {
  if (total <= 0) return { left: 0, width: 100 };
  const left = Math.min(100, (span.offset_ms / total) * 100);
  return { left, width: Math.min(100 - left, Math.max(0.8, (span.duration_ms / total) * 100)) };
}

/** The mini bar of a row's duration (design: 80 % at the p95, never past 100 %). */
export const durationWidth = (ms: number, p95: number | null) =>
  Math.min(100, (ms / Math.max(p95 ?? 0, 1)) * 80);

/** A new page appended to the loaded ones, without repeating a trace. */
export function appendPage(loaded: readonly Trace[], next: readonly Trace[]): Trace[] {
  const seen = new Set(loaded.map((trace) => trace.id));
  return [...loaded, ...next.filter((trace) => !seen.has(trace.id))];
}
