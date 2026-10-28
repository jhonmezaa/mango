import { z } from 'zod';

import type { SseMessage } from './sse';
import {
  approvalSchema,
  conversationIdSchema,
  registrationIdSchema,
  remoteSourcesSchema,
  toolStatusSchema,
} from './schemas';

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
  /** Remote MCP registrations whose tools answered («Leyó {servicio}»); never content or URLs. */
  remote_sources: remoteSourcesSchema.optional(),
});
const errorEvent = z.object({ code: z.string(), message: z.string() });
/**
 * A knowledge search of the turn (D88 (44)): the knowledge bases that answered, how many
 * fragments and, for each source, its document and page. Never the text of a fragment; plain
 * text, rendered as text.
 */
export const citationSchema = z.object({
  knowledge_base: z.string().max(200),
  document: z.string().max(200),
  page: z.number().int().positive().optional(),
});
const knowledgeEvent = z.object({
  knowledge_bases: z.array(z.string().max(200)).max(10),
  count: z.number().int().min(0).max(100),
  sources: z.array(citationSchema).max(20),
});

/**
 * A tool of a remote MCP asked the person to connect their account (D98 (20)): only the
 * registration, never a URL. The card is built from it and the person's connections.
 */
export const remoteConnectionEvent = z.object({ registration_id: registrationIdSchema });

export type ChatEvent =
  | ({ type: 'conversation' } & z.infer<typeof conversationEvent>)
  | ({ type: 'tool' } & z.infer<typeof toolEvent>)
  | ({ type: 'status' } & z.infer<typeof statusEvent>)
  | ({ type: 'delta' } & z.infer<typeof deltaEvent>)
  | { type: 'approval'; approval: z.infer<typeof approvalSchema> }
  | ({ type: 'knowledge' } & z.infer<typeof knowledgeEvent>)
  | ({ type: 'remote_connection_required' } & z.infer<typeof remoteConnectionEvent>)
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
  knowledge: knowledgeEvent,
  remote_connection_required: remoteConnectionEvent,
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
