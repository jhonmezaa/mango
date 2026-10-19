import type { Task, TaskList, TaskRun } from './model';

export const XSS = '<img src=x onerror=alert(1)>';

export function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    run_id: 'b'.repeat(32),
    trigger: 'schedule',
    status: 'ok',
    queued_at: '2026-10-15T14:30:00Z',
    started_at: '2026-10-15T14:30:01Z',
    ended_at: '2026-10-15T14:30:07Z',
    cost_usd: '0.0800',
    reason: null,
    has_result: true,
    approvals: [],
    ...overrides,
  };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'a'.repeat(32),
    name: 'Budget check diario',
    agent_id: 'finops',
    agent_name: 'FinOps',
    task: 'Revisa el consumo del presupuesto mensual y avisa si pasa del 80%.',
    trigger: {
      kind: 'schedule',
      schedule: { freq: 'daily', hour: 9, minute: 30, days: [], dow: 1, dom: 1 },
      timezone: 'America/Mexico_City',
      event_type: null,
      daily_cap: null,
    },
    deliver: 'inbox',
    status: 'active',
    paused_reason: null,
    paused_at: null,
    retired: null,
    owner: { user_id: 'user-1', email: 'usuario1@empresa.com', name: 'Usuario 1' },
    is_owner: true,
    next_runs: ['2026-10-16T15:30:00Z', '2026-10-17T15:30:00Z', '2026-10-18T15:30:00Z'],
    running: false,
    runs: [run()],
    health: null,
    created_at: '2026-10-15T10:00:00+00:00',
    updated_at: '2026-10-15T10:00:00+00:00',
    ...overrides,
  };
}

export function list(items: Task[], overrides: Partial<TaskList> = {}): TaskList {
  return { items, can_create: true, can_subscribe_events: true, ...overrides };
}

export const AGENTS = {
  items: [
    {
      id: 'finops',
      status: 'published',
      version: 1,
      lock_version: null,
      name: 'FinOps',
      description: 'Costos',
      category: 'FinOps',
      icon: 'Money',
      color: 0,
      role: 'Analista',
      reports_to: null,
      model: 'm',
      allowed_models: ['m'],
      tools: ['cost-explorer.get_cost_and_usage'],
      unavailable_tools: [],
      published_at: '2026-10-01T00:00:00Z',
      retired_at: null,
      retire_reason: null,
      is_mine: false,
    },
  ],
};
