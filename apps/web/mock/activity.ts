/**
 * Mock route of the Actividad (D90): GET /activity, with the rules of `mango_api.activity` over the
 * other mocks. The mock user is an administrator, so the scope is everyone's: their own tool calls
 * (from the chat and tasks mocks) carry their conversation, task and run; the turns of other
 * people (seeded here) carry only the agent, the tool, the result and the time. The response
 * follows the generated contract (packages/ts/api-client).
 */
import { agents, versionOf } from './agents.ts';
import { activityApprovals } from './approvals.ts';
import { toolCallsOfMine } from './chat.ts';
import { sendError, sendJson, type ApiHandler } from './http.ts';
import { toolStepsOfMine } from './tasks.ts';

const MAX_EVENTS = 1000;
const RETENTION_DAYS = 30;
const RANGES: Record<string, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 };
const MINUTE = 60_000;

/**
 * Turns of other people: [minutes ago, calls [tool, ms] (ms null: the call failed)]. Design round
 * 20 (`ACT_AV_TURNS`): the tools of account data take seconds (the first measured in an
 * installation: get_cost_and_usage, 19.319 ms) and the longest more than a minute.
 */
const OTHERS: [number, [string, number | null][]][] = [
  [
    6,
    [
      ['get_cost_and_usage', 14_820],
      ['get_dimension_values', 3_140],
      ['get_cost_and_usage', 11_260],
    ],
  ],
  [
    22,
    [
      ['get_cost_and_usage', 16_400],
      ['get_dimension_values', 2_410],
    ],
  ],
  [
    120,
    [
      ['get_dimension_values', 3_380],
      ['get_cost_and_usage', null],
    ],
  ],
  [
    190,
    [
      ['get_cost_forecast', 9_620],
      ['get_cost_and_usage', 74_300],
    ],
  ],
  [1500, [['get_cost_and_usage', 10_980]]],
  [
    4300,
    [
      ['get_dimension_values', 2_650],
      ['get_cost_and_usage', 20_480],
    ],
  ],
];
const BUDGET_BLOCKED_MINUTES = 300;
const loadedAt = Date.now();

type Event = {
  id: string;
  kind: 'tool' | 'error' | 'approval' | 'budget';
  agent_id: string;
  at: string;
  tool: string | null;
  ms: number | null;
  ok: boolean | null;
  approval_id: string | null;
  approval_status: string | null;
  mine: boolean;
  conversation_id: string | null;
  task_id: string | null;
  run_id: string | null;
  task_name: string | null;
};

const hash = (text: string) => {
  let value = 0;
  for (let i = 0; i < text.length; i += 1) value = (value * 31 + text.charCodeAt(i)) >>> 0;
  return value;
};
/** Design round 20 (`actMs`): a stable latency of seconds for each call of a tool. */
const msOf = (tool: string, seed: string) => {
  const value = hash(seed);
  if (tool === 'get_dimension_values') return 1600 + (value % 3400);
  if (tool === 'get_cost_forecast') return 6500 + (value % 9000);
  return 8000 + (value % 19000);
};
const eventId = (at: number, seed: string) =>
  `${String(at).padStart(13, '0')}${hash(seed).toString(16).padStart(8, '0')}${'0'.repeat(8)}`;

function base(fields: Partial<Event> & Pick<Event, 'id' | 'kind' | 'agent_id' | 'at'>): Event {
  return {
    tool: null,
    ms: null,
    ok: null,
    approval_id: null,
    approval_status: null,
    mine: false,
    conversation_id: null,
    task_id: null,
    run_id: null,
    task_name: null,
    ...fields,
  };
}

function events(): Event[] {
  const own = toolCallsOfMine().map((call, index) => {
    const at = Date.parse(call.at) + index * 9_000;
    return base({
      id: eventId(at, `chat:${call.conversation_id}:${String(index)}`),
      kind: 'tool',
      agent_id: call.agent_id,
      at: new Date(at).toISOString(),
      tool: call.tool,
      ms: msOf(call.tool, `${call.conversation_id}${String(index)}`),
      ok: true,
      mine: true,
      conversation_id: call.conversation_id,
    });
  });
  const tasks = toolStepsOfMine().map((step, index) =>
    base({
      id: eventId(Date.parse(step.at), `task:${step.run.run_id}:${String(index)}`),
      kind: 'tool',
      agent_id: step.task.agent_id,
      at: step.at,
      tool: step.tool,
      ms: msOf(step.tool, `${step.run.run_id}${String(index)}`),
      ok: true,
      mine: true,
      task_id: step.task.task_id,
      run_id: step.run.run_id,
      task_name: step.task.name,
    }),
  );
  const others = OTHERS.flatMap(([minutes, calls]) =>
    calls.map(([tool, ms], index) => {
      const at = loadedAt - minutes * MINUTE + index * 9_000;
      return base({
        id: eventId(at, `other:${String(minutes)}:${String(index)}`),
        kind: ms === null ? 'error' : 'tool',
        agent_id: 'finops',
        at: new Date(at).toISOString(),
        tool,
        ms,
        ok: ms !== null,
      });
    }),
  );
  const blockedAt = loadedAt - BUDGET_BLOCKED_MINUTES * MINUTE;
  const blocked = base({
    id: eventId(blockedAt, 'budget'),
    kind: 'budget',
    agent_id: 'finops',
    at: new Date(blockedAt).toISOString(),
  });
  const approvals = activityApprovals().map((item) =>
    base({
      id: `approval-${item.approval_id}`,
      kind: 'approval',
      agent_id: item.agent_id,
      at: item.created_at,
      tool: item.tool,
      approval_id: item.approval_id,
      approval_status: item.status,
      mine: item.mine,
    }),
  );
  return [...own, ...tasks, ...others, blocked, ...approvals];
}

function agentsOut(seen: Set<string>) {
  return [...agents.values()]
    .filter((agent) => agent.status === 'published' || seen.has(agent.agent_id))
    .flatMap((agent) => {
      const version = versionOf(agent, agent.published_version);
      if (!version) return [];
      const { name, icon, color } = version.definition;
      return [{ id: agent.agent_id, name, icon, color, published: agent.status === 'published' }];
    });
}

export const handleActivity: ApiHandler = (req, res, path, url) => {
  if (path !== '/activity' || req.method !== 'GET') return Promise.resolve(false);
  const range = url.searchParams.get('range') ?? '24h';
  const windowMs = RANGES[range];
  if (windowMs === undefined) {
    sendError(res, 422, 'invalid_request', 'invalid fields: range');
    return Promise.resolve(true);
  }
  const now = Date.now();
  let start = now - windowMs;
  const since = url.searchParams.get('since');
  if (since !== null) {
    const parsed = Date.parse(since);
    if (Number.isNaN(parsed)) {
      sendError(res, 422, 'invalid_request', 'invalid fields: since');
      return Promise.resolve(true);
    }
    start = Math.min(Math.max(start, parsed), now);
  }
  const all = events()
    .filter((event) => {
      const at = Date.parse(event.at);
      return at > start && at <= now;
    })
    .sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
  const shown = all.slice(0, MAX_EVENTS);
  sendJson(res, 200, {
    scope: 'all',
    events: shown,
    truncated: all.length > MAX_EVENTS,
    agents: agentsOut(new Set(shown.map((event) => event.agent_id))),
    retention_days: RETENTION_DAYS,
  });
  return Promise.resolve(true);
};
