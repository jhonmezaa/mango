/**
 * Mock route of Observability (D108, D109): GET /observability, with the rules of
 * `mango_api.observability` (ranges, filters, search `q`, pages of 40, aggregates of the whole
 * reading) over traces seeded here. The mock user is an administrator. Metadata only, as the API:
 * no text of a question, an answer or a tool. The response follows the generated contract.
 */
import { agents, publishedVersion } from './agents.ts';
import { sendError, sendJson, type ApiHandler } from './http.ts';

const HOUR = 3_600_000;
const RANGES: Record<string, number> = { '1h': HOUR, '6h': 6 * HOUR, '24h': 24 * HOUR };
const PAGE = 40;
const MAX_PAGE = 200;
const MODEL = 'us.anthropic.claude-sonnet-4-6';
const FAST_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const PRICE = { input: 3, output: 15 };
const loadedAt = Date.now();

/** Agents with traces, their tools (`<target>___<tool>`, as the harness names them) and model. */
const SEEDS: { agent: string; model: string; tools: string[]; failEvery: number }[] = [
  {
    agent: 'finops',
    model: MODEL,
    tools: ['mango_finops___get_cost_and_usage', 'mango_finops___get_dimension_values'],
    failEvery: 9,
  },
  {
    agent: 'k3fq7zr2m5xw6n4a',
    model: FAST_MODEL,
    tools: ['mango_finops___get_savings_plans_coverage'],
    failEvery: 0,
  },
  {
    agent: 'b6t2hd5yq7lc3vpe',
    model: MODEL,
    tools: ['mango_finops___get_anomalies', 'mango_finops___get_cost_and_usage'],
    failEvery: 5,
  },
];
const PEOPLE = ['usuario1@empresa.com', 'usuario2@empresa.com', 'usuario3@empresa.com'];

type Span = {
  kind: 'model' | 'tool';
  name: string | null;
  offset_ms: number;
  duration_ms: number;
  failed: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
};

type Trace = {
  id: string;
  agent_id: string;
  agent_name: string | null;
  agent_version: number | null;
  playground: boolean;
  origin: 'chat' | 'task' | 'playground' | 'eval' | null;
  user_id: string | null;
  user_email: string | null;
  matched: boolean;
  started_at: string;
  duration_ms: number;
  status: 'ok' | 'error';
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null;
  model_calls: number;
  tool_calls: number;
  tools_failed: number;
  spans: Span[];
  more_spans: number;
};

const hash = (text: string) => {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
};
const hex32 = (seed: string) =>
  [0, 1, 2, 3]
    .map((i) =>
      hash(`${seed}:${String(i)}`)
        .toString(16)
        .padStart(8, '0'),
    )
    .join('');

function nameOf(agentId: string): string | null {
  const agent = agents.get(agentId);
  const version = agent ? (publishedVersion(agent) ?? agent.versions.at(-1) ?? null) : null;
  return version?.definition.name ?? null;
}

function makeTrace(seed: (typeof SEEDS)[number], n: number): Trace {
  const key = `${seed.agent}:${String(n)}`;
  const r = hash(key);
  const minutesAgo = (r % (24 * 60 - 2)) + 1;
  const toolCount = 1 + (r % seed.tools.length);
  const unmatched = n % 11 === 7;
  const origin = n % 4 === 1 ? 'task' : n % 13 === 3 ? 'playground' : 'chat';
  const spans: Span[] = [];
  let at = 0;
  const first = 400 + (r % 1300);
  spans.push({
    kind: 'model',
    name: seed.model,
    offset_ms: 0,
    duration_ms: first,
    failed: false,
    input_tokens: 900 + (r % 2500),
    output_tokens: 60,
  });
  at += first;
  let failedTools = 0;
  for (let i = 0; i < toolCount; i += 1) {
    const ms = 150 + (hash(`${key}:${String(i)}`) % 4200);
    const failed = seed.failEvery > 0 && n % seed.failEvery === 0 && i === toolCount - 1;
    if (failed) failedTools += 1;
    spans.push({
      kind: 'tool',
      name: seed.tools[i % seed.tools.length] ?? null,
      offset_ms: at + 20,
      duration_ms: ms,
      failed,
      input_tokens: null,
      output_tokens: null,
    });
    at += ms + 20;
  }
  const last = 600 + (r % 1800);
  const output = 200 + (r % 900);
  spans.push({
    kind: 'model',
    name: seed.model,
    offset_ms: at,
    duration_ms: last,
    failed: false,
    input_tokens: 1200 + (r % 3000),
    output_tokens: output,
  });
  at += last;
  const input = spans.reduce((sum, span) => sum + (span.input_tokens ?? 0), 0);
  const outTokens = spans.reduce((sum, span) => sum + (span.output_tokens ?? 0), 0);
  const cost = ((input * PRICE.input + outTokens * PRICE.output) / 1e6).toFixed(6);
  const person = PEOPLE[n % PEOPLE.length] ?? null;
  return {
    id: hex32(key),
    agent_id: seed.agent,
    agent_name: nameOf(seed.agent),
    agent_version: unmatched ? null : 1,
    playground: !unmatched && origin === 'playground',
    origin: unmatched ? null : origin,
    user_id: unmatched ? null : `user-${String(n % PEOPLE.length)}`,
    user_email: unmatched ? null : person,
    matched: !unmatched,
    started_at: new Date(loadedAt - minutesAgo * 60_000).toISOString(),
    duration_ms: at,
    status: failedTools ? 'error' : 'ok',
    model: seed.model,
    input_tokens: input,
    output_tokens: outTokens,
    cost_usd: unmatched ? null : cost,
    model_calls: 2,
    tool_calls: toolCount,
    tools_failed: failedTools,
    spans,
    more_spans: 0,
  };
}

const ALL: Trace[] = SEEDS.flatMap((seed, index) =>
  Array.from({ length: [34, 12, 22][index] ?? 10 }, (_, n) => makeTrace(seed, n)),
);

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
}

function matches(trace: Trace, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const values = [
    trace.id,
    trace.user_email ?? '',
    ...trace.spans.flatMap((s) => (s.kind === 'tool' && s.name ? [s.name] : [])),
  ];
  return values.some((value) => value.toLowerCase().includes(needle));
}

function reading(range: string, agent: string | null, now: number) {
  const windowMs = RANGES[range] ?? HOUR;
  const start = now - windowMs;
  const traces = ALL.filter(
    (trace) =>
      Date.parse(trace.started_at) >= start && (agent === null || trace.agent_id === agent),
  ).sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id));
  const durations = traces.map((trace) => trace.duration_ms);
  const failed = traces.filter((trace) => trace.status === 'error').length;
  const firstHour = Math.floor(start / HOUR);
  const lastHour = Math.floor((now - 1) / HOUR);
  const hourly = [];
  for (let hour = firstHour; hour <= lastHour; hour += 1) {
    const of = traces.filter((trace) => Math.floor(Date.parse(trace.started_at) / HOUR) === hour);
    const errors = of.filter((trace) => trace.status === 'error').length;
    hourly.push({
      hour: new Date(hour * HOUR).toISOString(),
      ok: of.length - errors,
      error: errors,
    });
  }
  const byAgent = [...new Set(traces.map((trace) => trace.agent_id))]
    .map((id) => {
      const of = traces.filter((trace) => trace.agent_id === id);
      return {
        agent_id: id,
        agent_name: nameOf(id),
        traces: of.length,
        p95_ms:
          percentile(
            of.map((trace) => trace.duration_ms),
            0.95,
          ) ?? 0,
        failed: of.filter((trace) => trace.status === 'error').length,
      };
    })
    .sort((a, b) => b.p95_ms - a.p95_ms);
  const calls = new Map<string, Span[]>();
  for (const trace of traces)
    for (const span of trace.spans)
      if (span.kind === 'tool' && span.name)
        calls.set(span.name, [...(calls.get(span.name) ?? []), span]);
  const tools = [...calls.entries()]
    .map(([name, of]) => ({
      name,
      calls: of.length,
      failed: of.filter((span) => span.failed).length,
      p95_ms:
        percentile(
          of.map((span) => span.duration_ms),
          0.95,
        ) ?? 0,
    }))
    .sort((a, b) => b.failed - a.failed || b.p95_ms - a.p95_ms)
    .slice(0, 10);
  const cost = traces.reduce((sum, trace) => sum + Number(trace.cost_usd ?? 0), 0);
  return {
    traces,
    out: {
      range,
      generated_at: new Date(now).toISOString(),
      capped: false,
      unreadable: 0,
      unmatched: traces.filter((trace) => !trace.matched).length,
      summary: {
        traces: traces.length,
        agents: byAgent.length,
        p50_ms: percentile(durations, 0.5),
        p95_ms: percentile(durations, 0.95),
        failed,
        failed_by_tool: traces.filter((trace) => trace.tools_failed > 0).length,
        error_percent: traces.length ? ((failed * 100) / traces.length).toFixed(1) : '0.0',
        cost_usd: cost.toFixed(6),
        input_tokens: traces.reduce((sum, trace) => sum + (trace.input_tokens ?? 0), 0),
        output_tokens: traces.reduce((sum, trace) => sum + (trace.output_tokens ?? 0), 0),
      },
      hourly,
      by_agent: byAgent,
      tools,
    },
  };
}

export const handleObservability: ApiHandler = (req, res, path, url) => {
  if (path !== '/observability' || req.method !== 'GET') return Promise.resolve(false);
  const params = url.searchParams;
  const range = params.get('range') ?? '24h';
  const status = params.get('status') ?? 'all';
  const agent = params.get('agent');
  const q = params.get('q') ?? '';
  const offset = Number(params.get('offset') ?? '0');
  const limit = Number(params.get('limit') ?? String(PAGE));
  if (
    !(range in RANGES) ||
    !['all', 'error', 'slow'].includes(status) ||
    (agent !== null && !/^(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})$/.test(agent)) ||
    agent === 'evals' ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE ||
    q.length > 100
  ) {
    sendError(res, 422, 'invalid_request', 'invalid fields');
    return Promise.resolve(true);
  }
  const { traces, out } = reading(range, agent, Date.now());
  const slow = out.summary.p95_ms;
  const filtered = traces.filter(
    (trace) =>
      matches(trace, q) &&
      (status === 'all' ||
        (status === 'error'
          ? trace.status === 'error'
          : slow !== null && trace.duration_ms >= slow)),
  );
  sendJson(res, 200, {
    ...out,
    total: filtered.length,
    offset,
    traces: filtered.slice(offset, offset + limit),
  });
  return Promise.resolve(true);
};
