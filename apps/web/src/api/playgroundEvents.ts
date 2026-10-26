import { z } from 'zod';

import type { SseMessage } from './sse';
import { toolStatusSchema } from './schemas';

// Events of POST /api/playground/runs (D91): the chat's `delta`, `tool` and `status`, plus
// `simulated_write` (a write tool the agent asked for, never run) and a `done` with the flags
// of the result card. Unknown events are ignored; a known one with a bad payload is an error.

const toolEvent = z.object({ name: z.string().max(128), status: toolStatusSchema });
const deltaEvent = z.object({ text: z.string() });
const statusEvent = z.object({ phase: z.string().max(32), tool: z.string().max(128).optional() });
const simulatedWriteEvent = z.object({ tool: z.string().max(128) });
const doneEvent = z.object({
  stop_reason: z.string().max(64).nullable(),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
  cost_usd: z.string().regex(/^\d{1,9}(?:\.\d{1,8})?$/),
  duration_ms: z.number().int().min(0),
  flags: z.object({
    guardrail: z.boolean(),
    token_cap: z.boolean(),
    time_limit: z.boolean(),
    iteration_limit: z.boolean(),
  }),
});
/** `budget_exceeded` says whose budget ran out; the server's message is never shown. */
const errorEvent = z.object({
  code: z.string().max(64),
  scope: z.enum(['user', 'agent', 'unknown']).optional(),
});

export type PlaygroundEvent =
  | ({ type: 'tool' } & z.infer<typeof toolEvent>)
  | ({ type: 'status' } & z.infer<typeof statusEvent>)
  | ({ type: 'delta' } & z.infer<typeof deltaEvent>)
  | ({ type: 'simulated_write' } & z.infer<typeof simulatedWriteEvent>)
  | ({ type: 'done' } & z.infer<typeof doneEvent>)
  | ({ type: 'error' } & z.infer<typeof errorEvent>);

export type PlaygroundDone = Extract<PlaygroundEvent, { type: 'done' }>;

const schemas = {
  tool: toolEvent,
  status: statusEvent,
  delta: deltaEvent,
  simulated_write: simulatedWriteEvent,
  done: doneEvent,
  error: errorEvent,
} as const;

function isKnownEvent(name: string): name is keyof typeof schemas {
  return Object.hasOwn(schemas, name);
}

export function parsePlaygroundEvent(message: SseMessage): PlaygroundEvent | null {
  if (!isKnownEvent(message.event)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(message.data);
  } catch {
    return { type: 'error', code: 'invalid_event' };
  }
  const parsed = schemas[message.event].safeParse(payload);
  if (!parsed.success) return { type: 'error', code: 'invalid_event' };
  return { type: message.event, ...parsed.data } as PlaygroundEvent;
}
