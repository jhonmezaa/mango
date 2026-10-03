import { z } from 'zod';

import type { SseMessage } from './sse';
import { approvalSchema, conversationIdSchema, toolStatusSchema } from './schemas';

const conversationEvent = z.object({ conversation_id: conversationIdSchema });
const toolEvent = z.object({ name: z.string().max(128), status: toolStatusSchema });
const deltaEvent = z.object({ text: z.string() });
/**
 * Live progress of the turn, computed by the API (never text of the model). `phase` is kept as a
 * plain string so a phase added later does not break the stream: the UI falls back to "thinking".
 */
const statusEvent = z.object({ phase: z.string().max(32), tool: z.string().max(128).optional() });
const doneEvent = z.object({
  message_id: z.string(),
  stop_reason: z.string(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
  cost_usd: z.string(),
});
const errorEvent = z.object({ code: z.string(), message: z.string() });

export type ChatEvent =
  | ({ type: 'conversation' } & z.infer<typeof conversationEvent>)
  | ({ type: 'tool' } & z.infer<typeof toolEvent>)
  | ({ type: 'status' } & z.infer<typeof statusEvent>)
  | ({ type: 'delta' } & z.infer<typeof deltaEvent>)
  | { type: 'approval'; approval: z.infer<typeof approvalSchema> }
  | ({ type: 'done' } & z.infer<typeof doneEvent>)
  | ({ type: 'error' } & z.infer<typeof errorEvent>);

export type DoneEvent = Extract<ChatEvent, { type: 'done' }>;

const schemas = {
  // A write tool call that waits for a person (D27): the request as the API stored it.
  approval: approvalSchema.transform((approval) => ({ approval })),
  conversation: conversationEvent,
  tool: toolEvent,
  status: statusEvent,
  delta: deltaEvent,
  done: doneEvent,
  error: errorEvent,
} as const;

function isKnownEvent(name: string): name is keyof typeof schemas {
  return Object.hasOwn(schemas, name);
}

/**
 * Maps a raw SSE message to a typed chat event. Unknown event types return `null` (forward
 * compatible); known types with an invalid payload become a client-side `error` event.
 */
export function parseChatEvent(message: SseMessage): ChatEvent | null {
  if (!isKnownEvent(message.event)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(message.data);
  } catch {
    return { type: 'error', code: 'invalid_event', message: 'Malformed stream event' };
  }
  const parsed = schemas[message.event].safeParse(payload);
  if (!parsed.success) {
    return { type: 'error', code: 'invalid_event', message: 'Malformed stream event' };
  }
  return { type: message.event, ...parsed.data } as ChatEvent;
}
