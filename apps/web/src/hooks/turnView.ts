import { z } from 'zod';

import { citationSchema, remoteConnectionEvent } from '../api/chatEvents';
import type { Channels, Json } from '../api/deltas';
import {
  approvalSchema,
  remoteSourcesSchema,
  type ChatApproval,
  type ToolStatus,
} from '../api/schemas';

/**
 * What the chat shows of a turn read in `v1` (D120 (2), R3 notes): the documents of its
 * channels, validated by schema before anything of them reaches the screen. Channel 0 is the
 * answer (`channel: "final"`); each tool call is a message of its own (`recipient` = the tool's
 * display name, `content_type: "tool_call"`) and its result another one, without content.
 *
 * Everything here is data from the server, and the text from the model through it: it is shown
 * as text (React escapes it) or as Markdown without raw HTML, never interpreted.
 */

/** The statuses of a `v1` message. */
export type V1Status = 'in_progress' | 'finished' | 'error' | 'interrupted';

const statusSchema = z.enum(['in_progress', 'finished', 'error', 'interrupted']);

const messageSchema = z.object({
  id: z.string().max(200),
  author: z.object({ role: z.string().max(32) }),
  recipient: z.string().max(128),
  channel: z.string().max(32),
  content_type: z.string().max(32),
  status: statusSchema,
});

const phaseSchema = z.object({ phase: z.string().max(32), tool: z.string().max(128).optional() });

const knowledgeSchema = z.object({
  knowledge_bases: z.array(z.string().max(200)).max(10),
  count: z.number().int().min(0).max(100),
  sources: z.array(citationSchema).max(20),
});

const resultSchema = z.object({
  message_id: z.string().max(200).optional(),
  stop_reason: z.string().max(64).optional(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  cost_usd: z.string().max(32).optional(),
  remote_sources: remoteSourcesSchema.optional(),
});

const errorSchema = z.object({
  code: z.string().max(64),
  message: z.string().max(500).optional(),
  status: z.number().int().optional(),
});

const answerSchema = messageSchema.extend({
  channel: z.literal('final'),
  content: z.object({ text: z.string() }),
  metadata: z.object({
    phase: phaseSchema.nullable().optional(),
    knowledge: z.array(knowledgeSchema).max(50).optional(),
    approvals: z.array(z.unknown()).max(50).optional(),
    connection_required: z.array(remoteConnectionEvent.shape.registration_id).max(20).optional(),
    result: resultSchema.optional(),
    error: errorSchema.optional(),
  }),
});

export interface TurnTool {
  /** Display name of the tool, as the API named it (untrusted: rendered as text only). */
  name: string;
  status: ToolStatus;
}

export interface TurnView {
  status: V1Status;
  text: string;
  phase: z.infer<typeof phaseSchema> | null;
  /** The tool calls, in the order they started. */
  tools: TurnTool[];
  knowledge: z.infer<typeof knowledgeSchema>[];
  approvals: ChatApproval[];
  connectionRequired: string[];
  result: z.infer<typeof resultSchema> | null;
  error: z.infer<typeof errorSchema> | null;
}

export const EMPTY_TURN: TurnView = {
  status: 'in_progress',
  text: '',
  phase: null,
  tools: [],
  knowledge: [],
  approvals: [],
  connectionRequired: [],
  result: null,
  error: null,
};

/** A turn whose documents do not have the shape this client knows. */
export const INVALID_TURN: TurnView = {
  ...EMPTY_TURN,
  status: 'error',
  error: { code: 'invalid_event' },
};

const TOOL_STATUS: Record<V1Status, ToolStatus> = {
  in_progress: 'started',
  finished: 'completed',
  error: 'error',
  interrupted: 'error',
};

/** The view of the channels; `INVALID_TURN` when the answer's document is malformed. */
export function turnViewOf(channels: Channels): TurnView {
  const answerDoc: Json | undefined = channels.get(0);
  if (answerDoc === undefined) return EMPTY_TURN;
  const answer = answerSchema.safeParse(answerDoc);
  if (!answer.success || answer.data.author.role !== 'assistant') return INVALID_TURN;
  const { metadata } = answer.data;
  const tools: TurnTool[] = [];
  for (const [channel, doc] of [...channels.entries()].sort(([a], [b]) => a - b)) {
    if (channel === 0) continue;
    const message = messageSchema.safeParse(doc);
    // A message this client does not know is left out, never shown raw.
    if (!message.success) continue;
    const { data } = message;
    if (data.content_type === 'tool_call' && data.author.role === 'assistant') {
      tools.push({ name: data.recipient, status: TOOL_STATUS[data.status] });
    }
  }
  // Each approval is the request as the API stored it (D27); one that does not parse is left out.
  const approvals = (metadata.approvals ?? []).flatMap((item) => {
    const parsed = approvalSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    status: answer.data.status,
    text: answer.data.content.text,
    phase: metadata.phase ?? null,
    tools,
    knowledge: metadata.knowledge ?? [],
    approvals,
    connectionRequired: metadata.connection_required ?? [],
    result: metadata.result ?? null,
    error: metadata.error ?? null,
  };
}
