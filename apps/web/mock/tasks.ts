/**
 * Mock routes of the Schedules screen (D78): GET/POST /tasks, GET/PUT /tasks/{id}, POST
 * /tasks/{id}/{run,pause,resume,retire} and GET /tasks/{id}/runs/{run}. The response follows the
 * generated contract (packages/ts/api-client). The mock user owns every task it creates; a run
 * started with «Ejecutar ahora» ends two seconds later with a short answer.
 */
import { randomBytes } from 'node:crypto';

import { MOCK_USER } from './cognito.ts';
import { readObject, sendError, sendJson, type ApiHandler } from './http.ts';

type Spec = {
  freq: string;
  hour: number;
  minute: number;
  days: number[];
  dow: number;
  dom: number;
};
interface Run {
  run_id: string;
  trigger: 'manual' | 'schedule' | 'event';
  status: 'queued' | 'running' | 'ok' | 'failed' | 'skipped' | 'approval';
  queued_at: string;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: string | null;
  reason: string | null;
  result: string | null;
  approvals: string[];
}
interface Task {
  task_id: string;
  name: string;
  agent_id: string;
  task: string;
  trigger: {
    kind: 'schedule' | 'event';
    schedule: Spec | null;
    timezone: string | null;
    event_type: string | null;
  };
  status: 'active' | 'paused' | 'retired';
  paused_reason: 'owner' | null;
  paused_at: string | null;
  retired: { by: string; at: string; reason: string } | null;
  created_at: string;
  updated_at: string;
  runs: Run[];
}

const tasks = new Map<string, Task>();
const id = () => randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
const TASK_ROUTE = /^\/tasks\/([0-9a-f]{32})(?:\/(run|pause|resume|retire))?$/;
const RUN_ROUTE = /^\/tasks\/([0-9a-f]{32})\/runs\/([0-9a-f]{32})$/;

function summary(run: Run) {
  const { result, ...rest } = run;
  return { ...rest, has_result: Boolean(result) };
}

function out(task: Task) {
  const spec = task.trigger.schedule;
  const next =
    spec && task.status === 'active' ? [new Date(Date.now() + 3_600_000).toISOString()] : [];
  return {
    task_id: task.task_id,
    name: task.name,
    agent_id: task.agent_id,
    agent_name: null,
    task: task.task,
    trigger: { ...task.trigger, daily_cap: task.trigger.event_type ? 5 : null },
    deliver: 'inbox',
    status: task.status,
    paused_reason: task.paused_reason,
    paused_at: task.paused_at,
    retired: task.retired,
    owner: { user_id: 'mock-user', email: MOCK_USER, name: null },
    is_owner: true,
    next_runs: next,
    running: task.runs.some((run) => run.status === 'queued' || run.status === 'running'),
    runs: task.runs
      .slice(0, 10)
      .map(({ result, ...run }) => ({ ...run, has_result: Boolean(result) })),
    health: null,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function fromBody(
  body: Record<string, unknown>,
): Pick<Task, 'name' | 'agent_id' | 'task' | 'trigger'> | null {
  const trigger = body.trigger as Record<string, unknown> | undefined;
  if (
    typeof body.name !== 'string' ||
    typeof body.task !== 'string' ||
    typeof body.agent_id !== 'string'
  ) {
    return null;
  }
  if (!trigger || (trigger.kind !== 'schedule' && trigger.kind !== 'event')) return null;
  return {
    name: body.name,
    agent_id: body.agent_id,
    task: body.task,
    trigger:
      trigger.kind === 'event'
        ? { kind: 'event', schedule: null, timezone: null, event_type: 'cost_anomaly' }
        : {
            kind: 'schedule',
            schedule: {
              days: [],
              dow: 1,
              dom: 1,
              hour: 9,
              minute: 0,
              ...(trigger.schedule as Partial<Spec>),
              freq: (trigger.schedule as Spec).freq,
            },
            timezone:
              typeof trigger.timezone === 'string' ? trigger.timezone : 'America/Mexico_City',
            event_type: null,
          },
  };
}

export const handleTasks: ApiHandler = async (req, res, path) => {
  if (path === '/tasks' && req.method === 'GET') {
    sendJson(res, 200, {
      items: [...tasks.values()].map(out),
      can_create: true,
      can_subscribe_events: true,
    });
    return true;
  }
  if (path === '/tasks' && req.method === 'POST') {
    const body = await readObject(req, ['name', 'agent_id', 'task', 'trigger', 'deliver']);
    const fields = body ? fromBody(body) : null;
    if (!fields) {
      sendError(res, 422, 'invalid_request', 'invalid fields');
      return true;
    }
    const task: Task = {
      ...fields,
      task_id: id(),
      status: 'active',
      paused_reason: null,
      paused_at: null,
      retired: null,
      created_at: now(),
      updated_at: now(),
      runs: [],
    };
    tasks.set(task.task_id, task);
    sendJson(res, 201, out(task));
    return true;
  }
  const runMatch = RUN_ROUTE.exec(path);
  if (runMatch && req.method === 'GET') {
    const run = tasks.get(runMatch[1] ?? '')?.runs.find((item) => item.run_id === runMatch[2]);
    if (!run) sendError(res, 404, 'not_found', 'not found');
    else {
      const { result, ...rest } = run;
      sendJson(res, 200, { ...rest, has_result: Boolean(result), result });
    }
    return true;
  }
  const match = TASK_ROUTE.exec(path);
  if (!match) return false;
  const task = tasks.get(match[1] ?? '');
  if (!task) {
    sendError(res, 404, 'not_found', 'not found');
    return true;
  }
  const action = match[2];
  if (!action && req.method === 'GET') {
    sendJson(res, 200, out(task));
    return true;
  }
  if (!action && req.method === 'PUT') {
    const body = await readObject(req, ['name', 'agent_id', 'task', 'trigger', 'deliver']);
    const fields = body ? fromBody(body) : null;
    if (!fields) {
      sendError(res, 422, 'invalid_request', 'invalid fields');
      return true;
    }
    Object.assign(task, fields, { updated_at: now() });
    sendJson(res, 200, out(task));
    return true;
  }
  if (req.method !== 'POST') return false;
  if (action === 'run') {
    const run: Run = {
      run_id: id(),
      trigger: 'manual',
      status: 'queued',
      queued_at: now(),
      started_at: null,
      ended_at: null,
      cost_usd: null,
      reason: null,
      result: null,
      approvals: [],
    };
    task.runs.unshift(run);
    setTimeout(() => {
      Object.assign(run, {
        status: 'ok',
        started_at: run.queued_at,
        ended_at: now(),
        cost_usd: '0.0800',
        result:
          '**Gasto del mes:** USD 2.400,00 de USD 3.000,00 (80 %).\n\n- EC2: +12 %\n- S3: sin cambios',
      });
    }, 2000);
    sendJson(res, 202, summary(run));
    return true;
  }
  if (action === 'pause' || action === 'resume') {
    task.status = action === 'pause' ? 'paused' : 'active';
    task.paused_reason = action === 'pause' ? 'owner' : null;
    task.paused_at = action === 'pause' ? now() : null;
    sendJson(res, 200, out(task));
    return true;
  }
  const body = await readObject(req, ['reason']);
  if (!body || typeof body.reason !== 'string' || !body.reason.trim()) {
    sendError(res, 422, 'invalid_request', 'invalid fields: reason');
    return true;
  }
  task.status = 'retired';
  task.retired = { by: MOCK_USER, at: now(), reason: body.reason };
  sendJson(res, 200, out(task));
  return true;
};
