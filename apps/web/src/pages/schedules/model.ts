import type { OperationOutput } from '../../api/operations';

export type TaskList = OperationOutput<'listTasksOfCaller'>;
export type Task = TaskList['items'][number];
export type TaskRun = Task['runs'][number];
export type RunDetail = OperationOutput<'getTaskRun'>;
export type Spec = NonNullable<Task['trigger']['schedule']>;
export type Frequency = Spec['freq'];

/** Design SC_FREQ, in its order. */
export const FREQUENCIES: readonly Frequency[] = [
  '15m',
  'hourly',
  '6h',
  'daily',
  'weekdays',
  'days',
  'weekly',
  'monthly',
];
/** Design: the time zones the editor offers (the API accepts these and nothing else). */
export const TIMEZONES = [
  'America/Mexico_City',
  'America/Bogota',
  'America/Sao_Paulo',
  'UTC',
] as const;
export type TimeZone = (typeof TIMEZONES)[number];
export const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const RUNS_PER_MONTH: Record<Frequency, (spec: Spec) => number> = {
  '15m': () => 2880,
  hourly: () => 720,
  '6h': () => 120,
  daily: () => 30,
  weekdays: () => 22,
  days: (spec) => spec.days.length * 4.3,
  weekly: () => 4.3,
  monthly: () => 1,
};

export type TaskStatus = 'active' | 'paused' | 'retired';
export type QuickFilter = 'all' | TaskStatus | 'attention';
export const QUICK: readonly QuickFilter[] = ['all', 'active', 'paused', 'attention', 'retired'];
export type RunTone = 'green' | 'red' | 'dim' | 'amber' | 'muted';
/** Design SC_RUN. «Ejecutando…» shows a spinner instead of its dot. */
export const RUN_TONE: Record<string, RunTone> = {
  ok: 'green',
  failed: 'red',
  skipped: 'dim',
  approval: 'amber',
  queued: 'muted',
  running: 'muted',
};
/** Design SC_STARTED: the runs that count for the daily cap (the skipped ones do not). */
const STARTED = new Set(['ok', 'failed', 'approval', 'running']);

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** Design scCron: the five-field cron shown in «Programación». The API never takes it. */
export function cronOf(spec: Spec): string {
  const { minute: m, hour: h } = spec;
  switch (spec.freq) {
    case '15m':
      return '*/15 * * * *';
    case 'hourly':
      return `${m} * * * *`;
    case '6h':
      return `${m} */6 * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'days':
      return `${m} ${h} * * ${spec.days.join(',')}`;
    case 'weekly':
      return `${m} ${h} * * ${spec.dow}`;
    case 'monthly':
      return `${m} ${h} ${spec.dom} * *`;
  }
}

export function perMonth(spec: Spec): number {
  return RUNS_PER_MONTH[spec.freq](spec);
}

export function isEvent(task: Task): boolean {
  return task.trigger.kind === 'event';
}

/** A run still waiting for its end. */
export function isOpen(run: TaskRun): boolean {
  return run.status === 'queued' || run.status === 'running';
}

export type Health = {
  tone: 'red' | 'amber';
  key: 'agent_unavailable' | 'access_lost' | 'failing' | 'tools';
  values?: Record<string, string>;
};

/**
 * Design `health`: what makes a task «need attention». The API says what it knows (agent,
 * access, failures); the tools of the agent come from the marketplace list.
 */
export function healthOf(
  task: Task,
  unavailableTools: readonly string[] | undefined,
): Health | null {
  if (task.status === 'retired') return null;
  if (task.health) return { tone: task.health.tone, key: task.health.code };
  if (unavailableTools && unavailableTools.length > 0) {
    return { tone: 'amber', key: 'tools', values: { tools: unavailableTools.join(', ') } };
  }
  return null;
}

export function needsAttention(task: Task, health: Health | null): boolean {
  return task.status !== 'retired' && health !== null;
}

export function matchesQuick(task: Task, quick: QuickFilter, health: Health | null): boolean {
  if (quick === 'all') return task.status !== 'retired';
  if (quick === 'attention') return needsAttention(task, health);
  return task.status === quick;
}

const DAY_MS = 86_400_000;

/** «Costo estimado · mes» (design): tasks by schedule, the average cost of a run times the runs
 * a month; tasks on an anomaly, what they cost in the last 30 days. */
export function monthlyEstimate(tasks: readonly Task[], now = Date.now()): number {
  let total = 0;
  for (const task of tasks) {
    if (task.status !== 'active') continue;
    const costs = task.runs.flatMap((run) => (run.cost_usd === null ? [] : [run]));
    const spec = task.trigger.schedule;
    if (isEvent(task)) {
      for (const run of costs) {
        if (now - new Date(run.queued_at).getTime() < 30 * DAY_MS) total += Number(run.cost_usd);
      }
    } else if (spec && costs.length > 0) {
      const sum = costs.reduce((acc, run) => acc + Number(run.cost_usd), 0);
      total += (sum / costs.length) * perMonth(spec);
    }
  }
  return total;
}

/** The start of a UTC day (``offset`` days from today): the day of the daily cap (design). */
export function utcDay(offset = 0, now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset);
}

/** Design scToday: the runs that started today (UTC), which count for the cap. */
export function startedToday(task: Task, now = new Date()): number {
  const day = utcDay(0, now);
  return task.runs.filter(
    (run) => STARTED.has(run.status) && new Date(run.started_at ?? run.queued_at).getTime() >= day,
  ).length;
}

export function durationMs(run: TaskRun): number | null {
  if (!run.started_at || !run.ended_at) return null;
  return new Date(run.ended_at).getTime() - new Date(run.started_at).getTime();
}

export const RUN_REASONS = [
  'budget_exceeded',
  'budget_unavailable',
  'access_lost',
  'not_central',
  'overlap',
  'daily_cap',
  'agent_unavailable',
  'model_unavailable',
  'identity_unavailable',
  'upstream_error',
  'harness_missing',
  'queue_unavailable',
  'task_retired',
  'task_paused',
  'paused_by_admin',
] as const;
export type RunReason = (typeof RUN_REASONS)[number];

export function isRunReason(value: string): value is RunReason {
  return (RUN_REASONS as readonly string[]).includes(value);
}

export const HEALTH_KEYS = ['agent_unavailable', 'access_lost', 'failing', 'tools'] as const;
export type HealthKey = (typeof HEALTH_KEYS)[number];

export interface Perms {
  own: boolean;
  anomaly: boolean;
  adminPaused: boolean;
  autoPaused: boolean;
  busy: TaskRun | undefined;
  canRun: boolean;
  canResume: boolean;
  canPause: boolean;
}

/**
 * Design scPerms: only the owner edits and runs it now; an administrator's pause also stops the
 * owner and only an administrator lifts it; an administrator may take over the owner's pause
 * (D78 (19), (21)). What a task paused by itself (lost access) allows is nothing but retiring.
 * The API decides every action; this only shows what the design shows.
 */
export function permsOf(task: Task, isAdmin: boolean): Perms {
  const own = task.is_owner;
  const anomaly = isEvent(task);
  const paused = task.status === 'paused';
  const adminPaused = paused && task.paused_reason === 'admin';
  const autoPaused = task.paused_reason === 'access_lost';
  const live = task.status !== 'retired' && !autoPaused;
  return {
    own,
    anomaly,
    adminPaused,
    autoPaused,
    busy: task.runs.find(isOpen),
    canRun: own && !anomaly && live && !adminPaused,
    canResume: live && paused && (adminPaused ? isAdmin : own),
    canPause: live && (!paused ? own || isAdmin : isAdmin && !own && !adminPaused),
  };
}

/** Why a task paused itself: its owner lost access to the agent, or stopped being central. */
export function autoPauseKind(task: Task): 'access' | 'central' {
  const cause = task.runs.find(
    (run) => run.reason === 'access_lost' || run.reason === 'not_central',
  );
  return cause?.reason === 'not_central' ? 'central' : 'access';
}
