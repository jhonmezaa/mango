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
export type RunTone = 'green' | 'red' | 'dim' | 'amber' | 'accent';
/** Design SC_RUN, plus the two states a run is in before it ends. */
export const RUN_TONE: Record<string, RunTone> = {
  ok: 'green',
  failed: 'red',
  skipped: 'dim',
  approval: 'amber',
  queued: 'accent',
  running: 'accent',
};

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

/** «Costo estimado · mes»: the average cost of a run times the runs a month (design). Tasks
 * that run on an event have no frequency: they are left out (brief, point 6). */
export function monthlyEstimate(tasks: readonly Task[]): number {
  let total = 0;
  for (const task of tasks) {
    const spec = task.trigger.schedule;
    if (task.status !== 'active' || !spec) continue;
    const costs = task.runs.flatMap((run) => (run.cost_usd === null ? [] : [Number(run.cost_usd)]));
    if (costs.length === 0) continue;
    const average = costs.reduce((sum, cost) => sum + cost, 0) / costs.length;
    total += average * perMonth(spec);
  }
  return total;
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
] as const;
export type RunReason = (typeof RUN_REASONS)[number];

export function isRunReason(value: string): value is RunReason {
  return (RUN_REASONS as readonly string[]).includes(value);
}

export const HEALTH_KEYS = ['agent_unavailable', 'access_lost', 'failing', 'tools'] as const;
export type HealthKey = (typeof HEALTH_KEYS)[number];
