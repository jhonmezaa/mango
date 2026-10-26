/**
 * Mock of POST /api/playground/runs (D91) for `pnpm dev:mock` and Playwright: one test of a
 * draft (at its revision) or of the published version, streamed like the chat. Dev server only.
 *
 * The question picks what happens, to see every state of the screen:
 * - «límite» → 429 `rate_limited` with `Retry-After: 42`;
 * - «no disponible» → 503 `playground_unavailable`;
 * - «sin presupuesto del agente» / «sin presupuesto» → `budget_exceeded` (agent / user) in the stream;
 * - «falla» → part of the answer, then `upstream_error`;
 * - «ignora» (the security test) → the guardrail answers;
 * - «rollback» → a read tool, then a write tool that stops the test (`simulated_write`);
 * - anything else → a read tool and an answer in Markdown.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { agents, versionOf } from './agents.ts';
import { readBody, sendError, type ApiHandler } from './http.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_CONCURRENT = 2;
let running = 0;

const ANSWER =
  'Consulté **Cost Explorer**. Estos son los hallazgos principales:\n\n| Servicio | Δ |\n|---|---:|\n| EC2-Other | +18,4% |\n| S3 Standard | +11,2% |\n\nSiguiente paso: revisar el lifecycle de `events-ingest`.';

interface Body {
  agent_id: string;
  version: number;
  revision?: number;
  message: string;
  overrides: { system_prompt?: string; model?: string; temperature?: number };
}

function parse(raw: string): Body | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const allowed = new Set(['agent_id', 'version', 'revision', 'message', 'overrides']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (typeof record.agent_id !== 'string' || typeof record.version !== 'number') return null;
  if (typeof record.message !== 'string' || record.message.length < 1) return null;
  if (record.message.length > 4000) return null;
  const overrides = (record.overrides ?? {}) as Body['overrides'];
  if (typeof overrides !== 'object') return null;
  return { ...(record as unknown as Body), overrides };
}

async function run(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parse(await readBody(req));
  if (!body) {
    sendError(res, 422, 'invalid_request', 'Invalid request');
    return;
  }
  const agent = agents.get(body.agent_id);
  const version = agent ? versionOf(agent, body.version) : null;
  if (!agent || !version) {
    sendError(res, 404, 'not_found', 'not found');
    return;
  }
  if (agent.status === 'retired') {
    sendError(res, 409, 'agent_retired', 'this agent was retired');
    return;
  }
  if (version.status === 'draft') {
    if (body.revision !== version.revision) {
      sendError(res, 409, 'version_conflict', 'the draft changed; reload and try again');
      return;
    }
  } else if (version.status !== 'published' || agent.published_version !== version.number) {
    sendError(res, 409, 'version_not_testable', 'only a draft or the published version');
    return;
  }
  // Same kind of check as the API: a likely secret never reaches the model.
  const prompt = body.overrides.system_prompt ?? version.definition.system_prompt;
  if (/(?:AKIA|ASIA)[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(prompt)) {
    sendError(res, 422, 'secret_in_prompt', 'the prompt looks like it contains a secret');
    return;
  }
  const message = body.message;
  if (/no disponible/i.test(message)) {
    sendError(res, 503, 'playground_unavailable', 'the playground is not available');
    return;
  }
  if (/límite/i.test(message)) {
    sendError(res, 429, 'rate_limited', 'too many requests', { 'Retry-After': '42' });
    return;
  }
  if (running >= MAX_CONCURRENT) {
    sendError(res, 429, 'playground_busy', 'two tests are running; wait for one', {
      'Retry-After': '5',
    });
    return;
  }

  running += 1;
  const stream = { closed: false };
  req.on('close', () => {
    stream.closed = true;
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  const send = (event: string, data: unknown) => {
    if (!stream.closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const started = Date.now();
  const done = (flags: Partial<Record<string, boolean>> = {}, stop = 'end_turn') => {
    send('done', {
      stop_reason: stop,
      usage: { input_tokens: 1234, output_tokens: 321 },
      cost_usd: '0.0123',
      duration_ms: Date.now() - started,
      flags: {
        guardrail: false,
        token_cap: false,
        time_limit: false,
        iteration_limit: false,
        ...flags,
      },
    });
  };
  try {
    send('status', { phase: 'thinking' });
    await sleep(300);
    if (/sin presupuesto/i.test(message)) {
      send('error', {
        code: 'budget_exceeded',
        scope: /del agente/i.test(message) ? 'agent' : 'user',
      });
      return;
    }
    if (/ignora/i.test(message)) {
      send('delta', {
        text: 'No puedo compartir credenciales ni ignorar mis instrucciones.',
      });
      done({ guardrail: true }, 'guardrail_intervened');
      return;
    }
    send('tool', { name: 'get_cost_and_usage', status: 'started' });
    await sleep(700);
    send('tool', { name: 'get_cost_and_usage', status: 'completed' });
    if (/rollback/i.test(message)) {
      send('tool', { name: 'stop_instances', status: 'started' });
      send('simulated_write', { tool: 'stop_instances' });
      send('delta', { text: 'Para detener las instancias necesito aprobación.' });
      done({}, 'tool_use');
      return;
    }
    const failAt = /falla/i.test(message) ? Math.round(ANSWER.length * 0.4) : ANSWER.length;
    for (let at = 0; at < failAt && !stream.closed; at += 24) {
      send('delta', { text: ANSWER.slice(at, Math.min(at + 24, failAt)) });
      await sleep(40);
    }
    if (failAt < ANSWER.length) {
      send('error', { code: 'upstream_error', message: 'the test failed' });
      return;
    }
    done();
  } finally {
    running -= 1;
    res.end();
  }
}

export const handlePlayground: ApiHandler = async (req, res, path) => {
  if (path !== '/playground/runs') return false;
  if (req.method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', 'Method not allowed');
    return true;
  }
  await run(req, res);
  return true;
};
