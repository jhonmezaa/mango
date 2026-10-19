/**
 * Mock routes of the Schedules screen (D78, D82): GET/POST /tasks, POST /tasks/next-runs, GET/PUT
 * /tasks/{id}, POST /tasks/{id}/{run,pause,resume,retire} and GET /tasks/{id}/runs/{run}. The
 * response follows the generated contract (packages/ts/api-client). The mock user (an
 * administrator and central) owns what it creates; three example tasks follow the design's demo
 * with neutral data: an investigation of cost anomalies, a task of another person paused by an
 * administrator, and a daily check with a run skipped for budget. A run started with «Ejecutar
 * ahora» ends two seconds later with a short answer in steps.
 *
 * Reports (D86): «Cierre mensual de costos» asks for a PDF (two ready, one that could not be
 * drawn), the investigations too (one without the agent's data). A run of a task with a report
 * leaves its PDF «generating» and ready 2.5 s later; POST /tasks/{id}/runs/{run}/report/download
 * answers a neutral https link and POST …/report/retry draws it again.
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
type Step = { text: string; tool: string | null };
type ReportType = 'cost_summary' | 'anomaly';
interface Report {
  type: ReportType;
  status: 'generating' | 'ready' | 'failed';
  reason: 'data' | 'size' | 'render' | null;
  period: string | null;
  file: string | null;
  pages: number | null;
  size_bytes: number | null;
  keep_until: string;
}
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
  steps: Step[];
  approvals: string[];
  anomaly: { start: string; end: string; id?: string | null } | null;
  waiting_since: string | null;
  report: Report | null;
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
  paused_reason: 'owner' | 'admin' | null;
  paused_at: string | null;
  paused_note: string | null;
  paused_by: string | null;
  retired: { by: string; at: string; reason: string } | null;
  owner: { user_id: string; email: string; name: string | null };
  created_at: string;
  updated_at: string;
  runs: Run[];
  report: ReportType | null;
}

const ME = { user_id: 'mock-user', email: MOCK_USER, name: null };
const OTHER = { user_id: 'user-2', email: 'usuario2@empresa.com', name: 'Usuario 2' };
const tasks = new Map<string, Task>();
const id = () => randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const isoDay = (offset: number) => {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
};
const TASK_ROUTE = /^\/tasks\/([0-9a-f]{32})(?:\/(run|pause|resume|retire))?$/;
const RUN_ROUTE = /^\/tasks\/([0-9a-f]{32})\/runs\/([0-9a-f]{32})$/;
const REPORT_ROUTE = /^\/tasks\/([0-9a-f]{32})\/runs\/([0-9a-f]{32})\/report\/(download|retry)$/;
const TASK_FIELDS = ['name', 'agent_id', 'task', 'trigger', 'deliver', 'report'];
const ZONES = ['America/Mexico_City', 'America/Bogota', 'America/Sao_Paulo', 'UTC'];

const REPORT =
  '## Anomalía en Amazon EC2\n\n**Impacto:** USD 412,30 sobre lo esperado.\n\n| Tipo de uso | Esperado | Real |\n|---|---|---|\n| BoxUsage | USD 640,00 | USD 1.052,30 |\n\n**Siguiente paso:** confirmar con el equipo dueño de la cuenta si el aumento fue intencional.';
const STEPS: Step[] = [
  {
    text: 'Busco la anomalía por su id para ver qué cuenta y tipo de uso la explican.',
    tool: 'get_anomalies',
  },
  { text: 'Comparo con los mismos días de la semana anterior.', tool: 'get_cost_and_usage' },
];

function run(overrides: Partial<Run>): Run {
  return {
    run_id: id(),
    trigger: 'event',
    status: 'ok',
    queued_at: ago(30),
    started_at: ago(30),
    ended_at: ago(29),
    cost_usd: '0.3100',
    reason: null,
    result: null,
    steps: [],
    approvals: [],
    anomaly: null,
    waiting_since: null,
    report: null,
    ...overrides,
  };
}

function report(type: ReportType, status: Report['status'], extra: Partial<Report> = {}): Report {
  return {
    type,
    status,
    reason: null,
    period: null,
    file: null,
    pages: status === 'ready' ? 2 : null,
    size_bytes: status === 'ready' ? 405 * 1024 : null,
    keep_until: isoDay(89),
    ...extra,
  };
}

/** Design scReportFile, enough for the mock: the task, the day and the hour of the run. */
function fileOf(task: Task, item: Run): string {
  const slug = task.name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const at = item.queued_at;
  const tail = item.anomaly?.id ? item.anomaly.id.slice(0, 8) : at.slice(11, 16).replace(':', '');
  return `${slug}-${at.slice(0, 10)}-${tail}.pdf`;
}

function seed() {
  const created = ago(60 * 24 * 7);
  // Neutral ids (design data), one per anomaly: the short id tells apart those of a day (D85).
  const anomalyOf = (id: string) => ({ start: isoDay(-1), end: isoDay(0), id });
  const anomaly = anomalyOf('8d09e1c2-4b5d-4e8f-9a01-8d092b3c4d5e');
  const yesterday = (hours: number) => {
    const at = new Date();
    at.setUTCDate(at.getUTCDate() - 1);
    at.setUTCHours(hours, 0, 0, 0);
    return at.toISOString();
  };
  const investigations: Task = {
    task_id: id(),
    name: 'Investigar anomalías de costo',
    agent_id: 'finops',
    task: 'Cuando AWS detecte una anomalía de costo, identifica qué cuenta, servicio y tipo de uso la explican, compárala con las dos semanas anteriores y propone el siguiente paso.',
    trigger: { kind: 'event', schedule: null, timezone: null, event_type: 'cost_anomaly' },
    status: 'active',
    paused_reason: null,
    paused_at: null,
    paused_note: null,
    paused_by: null,
    retired: null,
    owner: ME,
    created_at: created,
    updated_at: created,
    report: 'anomaly',
    runs: [
      run({
        anomaly,
        result: REPORT,
        steps: STEPS,
        queued_at: ago(20),
        started_at: ago(20),
        ended_at: ago(19),
        report: report('anomaly', 'failed', { reason: 'data' }),
      }),
      run({
        anomaly: anomalyOf('81c2e1c2-4b5d-4e8f-9a01-81c22b3c4d5e'),
        result: REPORT,
        steps: STEPS,
        queued_at: ago(51),
        waiting_since: ago(51),
        started_at: ago(50),
        ended_at: ago(49),
        cost_usd: '0.2700',
        report: report('anomaly', 'ready', { period: 'Amazon EC2' }),
      }),
      run({
        anomaly: anomalyOf('7f3ae1c2-4b5d-4e8f-9a01-7f3a2b3c4d5e'),
        result: REPORT,
        queued_at: ago(52),
        started_at: ago(52),
        ended_at: ago(51),
      }),
      run({
        status: 'skipped',
        reason: 'daily_cap',
        anomaly: { start: isoDay(-2), end: isoDay(-1), id: '7105e1c2-4b5d-4e8f-9a01-71052b3c4d5e' },
        queued_at: yesterday(21),
        started_at: null,
        ended_at: yesterday(21),
        cost_usd: null,
      }),
      run({
        status: 'skipped',
        reason: 'overlap',
        anomaly: { start: isoDay(-2), end: isoDay(-1), id: '6f58e1c2-4b5d-4e8f-9a01-6f582b3c4d5e' },
        queued_at: yesterday(15),
        started_at: null,
        ended_at: yesterday(15),
        cost_usd: null,
      }),
    ],
  };
  const cohort: Task = {
    task_id: id(),
    name: 'Cohort retention Q3',
    agent_id: 'finops',
    task: 'Recalcula la retención por cohorte y resume los cambios.',
    trigger: {
      kind: 'schedule',
      schedule: { freq: 'days', hour: 6, minute: 0, days: [1, 4], dow: 1, dom: 1 },
      timezone: 'UTC',
      event_type: null,
    },
    status: 'paused',
    paused_reason: 'admin',
    paused_at: ago(60 * 48),
    paused_note:
      'Recalcula todo el histórico en cada ejecución; revisemos el costo antes de seguir.',
    paused_by: 'usuario6@empresa.com',
    retired: null,
    owner: OTHER,
    created_at: created,
    updated_at: created,
    report: null,
    runs: [
      run({ trigger: 'schedule', result: 'Sin novedades.', queued_at: ago(60 * 72) }),
      run({
        trigger: 'schedule',
        status: 'failed',
        reason: 'upstream_error',
        queued_at: ago(60 * 96),
        cost_usd: '0.0400',
      }),
    ],
  };
  const budget: Task = {
    task_id: id(),
    name: 'Budget check diario',
    agent_id: 'finops',
    task: 'Revisa el consumo del presupuesto mensual y avisa si pasa del 80%.',
    trigger: {
      kind: 'schedule',
      schedule: { freq: 'daily', hour: 9, minute: 0, days: [], dow: 1, dom: 1 },
      timezone: 'America/Mexico_City',
      event_type: null,
    },
    status: 'active',
    paused_reason: null,
    paused_at: null,
    paused_note: null,
    paused_by: null,
    retired: null,
    owner: ME,
    created_at: created,
    updated_at: created,
    report: null,
    runs: [
      run({
        trigger: 'schedule',
        result: '**Gasto del mes:** USD 2.400,00 de USD 3.000,00 (80 %).',
        queued_at: ago(60 * 3),
        cost_usd: '0.0800',
      }),
      run({
        trigger: 'schedule',
        status: 'skipped',
        reason: 'budget_exceeded',
        queued_at: ago(60 * 27),
        started_at: null,
        cost_usd: null,
      }),
    ],
  };
  const months = (back: number) => {
    const at = new Date();
    at.setUTCMonth(at.getUTCMonth() - back, 1);
    at.setUTCHours(14, 0, 0, 0);
    return at.toISOString();
  };
  const monthName = (back: number) =>
    new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.parse(months(back + 1)) + 86_400_000),
    );
  const closing: Task = {
    task_id: id(),
    name: 'Cierre mensual de costos',
    agent_id: 'finops',
    task: 'Resume el costo del mes que cerró contra el anterior, por servicio y por cuenta.',
    trigger: {
      kind: 'schedule',
      schedule: { freq: 'monthly', hour: 8, minute: 0, days: [], dow: 1, dom: 1 },
      timezone: 'America/Mexico_City',
      event_type: null,
    },
    status: 'active',
    paused_reason: null,
    paused_at: null,
    paused_note: null,
    paused_by: null,
    retired: null,
    owner: ME,
    created_at: created,
    updated_at: created,
    report: 'cost_summary',
    runs: [0, 1, 2].map((back) =>
      run({
        trigger: 'schedule',
        result: `## Cierre de ${monthName(back)}\n\nEl costo subió un 5,5 % contra el mes anterior.`,
        queued_at: months(back),
        started_at: months(back),
        ended_at: months(back),
        cost_usd: '0.3800',
        report:
          back === 2
            ? report('cost_summary', 'failed', { reason: 'render', period: monthName(back) })
            : report('cost_summary', 'ready', { period: monthName(back) }),
      }),
    ),
  };
  for (const item of closing.runs) {
    if (item.report?.status === 'ready') item.report.file = fileOf(closing, item);
  }
  for (const item of investigations.runs) {
    if (item.report?.status === 'ready') item.report.file = fileOf(investigations, item);
  }
  for (const task of [investigations, closing, cohort, budget]) tasks.set(task.task_id, task);
}

/** The PDF is drawn 2.5 s later (design «Generando…»). */
function draw(task: Task, item: Run) {
  setTimeout(() => {
    if (item.report?.status !== 'generating') return;
    Object.assign(item.report, {
      status: 'ready',
      reason: null,
      file: fileOf(task, item),
      pages: 2,
      size_bytes: 405 * 1024,
    });
  }, 2500);
}
seed();

/** The next times of a spec in a zone (the mock: daily-like frequencies only, enough to see). */
function nextRuns(spec: Spec, zone: string, count = 3): string[] {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  const out: string[] = [];
  const start = Math.ceil(Date.now() / 60_000) * 60_000;
  for (let at = start; out.length < count && at < start + 40 * 86_400_000; at += 60_000) {
    const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
    const minute = Number(parts.minute);
    const hour = Number(parts.hour);
    const weekday = new Date(`${parts.year}-${parts.month}-${parts.day}`).getDay();
    const dom = Number(parts.day);
    const due =
      spec.freq === '15m'
        ? minute % 15 === 0
        : minute === spec.minute &&
          (spec.freq === 'hourly' || (spec.freq === '6h' ? hour % 6 === 0 : hour === spec.hour)) &&
          (spec.freq !== 'days' || spec.days.includes(weekday)) &&
          (spec.freq !== 'weekdays' || (weekday > 0 && weekday < 6)) &&
          (spec.freq !== 'weekly' || weekday === spec.dow) &&
          (spec.freq !== 'monthly' || dom === spec.dom);
    if (due) out.push(new Date(at).toISOString());
  }
  return out;
}

function summary(item: Run, owner: boolean) {
  const { result, steps, report: pdf, ...rest } = item;
  // Only the owner reads the period and the file of a PDF (D86 (4)).
  const shown =
    pdf && !owner ? { ...pdf, period: null, file: null, pages: null, size_bytes: null } : pdf;
  return { ...rest, report: shown, has_result: owner && Boolean(result ?? steps.length) };
}

function out(task: Task) {
  const spec = task.trigger.schedule;
  const own = task.owner.user_id === ME.user_id;
  return {
    task_id: task.task_id,
    name: task.name,
    agent_id: task.agent_id,
    agent_name: null,
    task: own ? task.task : null,
    trigger: { ...task.trigger, daily_cap: task.trigger.event_type ? 5 : null },
    deliver: 'inbox',
    report: task.report,
    status: task.status,
    paused_reason: task.paused_reason,
    paused_at: task.paused_at,
    paused_note: task.paused_note,
    // The mock user is an administrator: it reads who paused (D82 (2)).
    paused_by: task.paused_by,
    retired: task.retired,
    owner: task.owner,
    is_owner: own,
    next_runs:
      spec && task.status === 'active' ? nextRuns(spec, task.trigger.timezone ?? 'UTC') : [],
    running: task.runs.some((item) => item.status === 'queued' || item.status === 'running'),
    runs: task.runs.slice(0, 10).map((item) => summary(item, own)),
    health: null,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function fromBody(
  body: Record<string, unknown>,
): Pick<Task, 'name' | 'agent_id' | 'task' | 'trigger' | 'report'> | null {
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
    report: body.report === true ? (trigger.kind === 'event' ? 'anomaly' : 'cost_summary') : null,
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
  if (path === '/tasks/next-runs' && req.method === 'POST') {
    const body = await readObject(req, ['schedule', 'timezone']);
    const spec = body?.schedule as Partial<Spec> | undefined;
    const zone = body?.timezone;
    if (
      !spec ||
      typeof spec.freq !== 'string' ||
      typeof zone !== 'string' ||
      !ZONES.includes(zone)
    ) {
      sendError(res, 422, 'invalid_request', 'invalid fields');
      return true;
    }
    sendJson(res, 200, {
      next_runs: nextRuns(
        { days: [], dow: 1, dom: 1, hour: 9, minute: 0, ...spec, freq: spec.freq },
        zone,
      ),
    });
    return true;
  }
  if (path === '/tasks' && req.method === 'POST') {
    const body = await readObject(req, TASK_FIELDS);
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
      paused_note: null,
      paused_by: null,
      retired: null,
      owner: ME,
      created_at: now(),
      updated_at: now(),
      runs: [],
    };
    tasks.set(task.task_id, task);
    sendJson(res, 201, out(task));
    return true;
  }
  const reportMatch = REPORT_ROUTE.exec(path);
  if (reportMatch && req.method === 'POST') {
    const task = tasks.get(reportMatch[1] ?? '');
    const found = task?.runs.find((item) => item.run_id === reportMatch[2]);
    if (!task || !found || !(await readObject(req, []))) {
      sendError(res, 404, 'not_found', 'not found');
      return true;
    }
    if (task.owner.user_id !== ME.user_id) {
      sendError(res, 403, 'forbidden', 'only the owner downloads');
      return true;
    }
    if (reportMatch[3] === 'download') {
      if (found.report?.status !== 'ready' || !found.report.file) {
        sendError(res, 409, 'report_not_ready', 'this run has no PDF to download');
        return true;
      }
      // A neutral link: the mock never serves a PDF (design: «Descargar» opens nothing real).
      sendJson(res, 200, {
        url: `https://reports.example/${found.report.file}`,
        file: found.report.file,
      });
      return true;
    }
    if (found.report?.status !== 'failed' || found.report.reason !== 'render') {
      sendError(res, 409, 'report_not_retryable', 'this PDF cannot be generated again');
      return true;
    }
    Object.assign(found.report, { status: 'generating', reason: null });
    draw(task, found);
    sendJson(res, 200, summary(found, true));
    return true;
  }
  const runMatch = RUN_ROUTE.exec(path);
  if (runMatch && req.method === 'GET') {
    const task = tasks.get(runMatch[1] ?? '');
    const found = task?.runs.find((item) => item.run_id === runMatch[2]);
    if (!task || !found) sendError(res, 404, 'not_found', 'not found');
    else {
      const own = task.owner.user_id === ME.user_id;
      sendJson(res, 200, {
        ...summary(found, own),
        result: own ? found.result : null,
        steps: own ? found.steps : [],
      });
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
    const body = await readObject(req, TASK_FIELDS);
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
  const own = task.owner.user_id === ME.user_id;
  if (action === 'run') {
    const item = run({
      trigger: 'manual',
      status: 'queued',
      queued_at: now(),
      started_at: null,
      ended_at: null,
      cost_usd: null,
    });
    task.runs.unshift(item);
    setTimeout(() => {
      if (task.report) {
        item.report = report(task.report, 'generating', { period: 'mes en curso' });
        draw(task, item);
      }
      Object.assign(item, {
        status: 'ok',
        started_at: item.queued_at,
        ended_at: now(),
        cost_usd: '0.0800',
        steps: [
          { text: 'Voy a consultar el consumo del presupuesto del mes.', tool: 'get_budgets' },
        ],
        result:
          '**Gasto del mes:** USD 2.400,00 de USD 3.000,00 (80 %).\n\n- EC2: +12 %\n- S3: sin cambios',
      });
    }, 2000);
    sendJson(res, 202, summary(item, own));
    return true;
  }
  if (action === 'pause') {
    const body = await readObject(req, ['reason']);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (!own && !reason) {
      sendError(res, 422, 'reason_required', 'say why you pause this task');
      return true;
    }
    Object.assign(task, {
      status: 'paused',
      paused_reason: own ? 'owner' : 'admin',
      paused_at: now(),
      paused_note: own ? null : reason,
      paused_by: own ? null : MOCK_USER,
    });
    sendJson(res, 200, out(task));
    return true;
  }
  if (action === 'resume') {
    Object.assign(task, {
      status: 'active',
      paused_reason: null,
      paused_at: null,
      paused_note: null,
      paused_by: null,
    });
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

/** Runs of the mock user's tasks that completed or failed, for the Bandeja mock (D83). */
export function endedRunsOfMine() {
  return [...tasks.values()]
    .filter((task) => task.owner.user_id === ME.user_id)
    .flatMap((task) =>
      task.runs
        .filter((item) => (item.status === 'ok' || item.status === 'failed') && item.ended_at)
        .map((item) => ({ task, run: item })),
    );
}
