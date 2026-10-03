import { zApprovalOutSchema } from '@mango/api-client/schemas';
import { z } from 'zod';

// Hand-written mirror of docs/specs/poc-api-contract.md (v0). It will be replaced by the generated
// client in packages/ts/api-client once mango-api publishes its OpenAPI document. Responses are
// validated because API data is untrusted input for the renderer.

export const MESSAGE_MAX_LENGTH = 4000;

/** Conversation IDs are ULIDs/UUIDs; anything else is rejected before it reaches a URL. */
export const conversationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const meSchema = z.object({
  user_id: z.string(),
  /** Display only (never used for authorization); absent for tokens issued before it existed. */
  email: z.string().max(254).nullable().optional(),
  /** Display name chosen at sign-up (D20); display only. */
  name: z.string().max(128).nullable().optional(),
  /** FinOps role; null for users who only belong to access groups or to the creators group. */
  role: z.enum(['finops-central', 'bu-lead']).nullable(),
  business_unit: z.string().nullable(),
  is_admin: z.boolean(),
  /** Mango groups of the verified token (`cognito:groups`). */
  groups: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/)).max(100),
  /** UX hints only: the API authorizes every request on its own (REACT-AUTHZ-001). */
  can: z.object({ create_agent: z.boolean() }),
});
export type Me = z.infer<typeof meSchema>;

/** Agent ids: 16 base32 characters, or the slug of an agent of the release (`finops`). */
export const agentIdSchema = z.string().regex(/^(?:[a-z2-7]{16}|[a-z][a-z0-9]{1,15})$/);

/** Bedrock model or inference profile id (`mango_core.agents.MODEL_ID_PATTERN`). */
export const modelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.:_-]{0,127}$/);

export const conversationSummarySchema = z.object({
  conversation_id: conversationIdSchema,
  title: z.string(),
  updated_at: z.string(),
  /** Agent the conversation belongs to; it keeps the one of its first turn. */
  agent_id: agentIdSchema,
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationListSchema = z.object({ items: z.array(conversationSummarySchema) });

export const toolStatusSchema = z.enum(['started', 'completed', 'error']);
export type ToolStatus = z.infer<typeof toolStatusSchema>;

// Same bound as the stream `tool` event: stored history is rendered by the same UI.
export const toolCallSchema = z.object({ name: z.string().max(128), status: toolStatusSchema });
export type ToolCall = z.infer<typeof toolCallSchema>;

export const messageSchema = z.object({
  message_id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  created_at: z.string(),
  tools: z.array(toolCallSchema).default([]),
  /** Ids of the approval requests this message's write tool calls created (D27). */
  approvals: z
    .array(z.string().regex(/^[0-9a-f]{32}$/))
    .max(20)
    .optional(),
});
export type Message = z.infer<typeof messageSchema>;

/** A request to confirm a write tool call, as the API shows it (generated contract). */
export const approvalSchema = zApprovalOutSchema;
export type ChatApproval = z.infer<typeof approvalSchema>;

export const conversationSchema = z.object({
  conversation_id: conversationIdSchema,
  title: z.string(),
  agent_id: agentIdSchema,
  messages: z.array(messageSchema),
  /** The caller's requests to confirm write tool calls of this conversation. */
  approvals: z.array(approvalSchema).max(200).optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;

/** Normalized target of an audit event (`{type, id}`); absent on events written before it. */
export const auditResourceSchema = z.object({
  type: z.string().max(128),
  id: z.string().max(256),
});
export type AuditResource = z.infer<typeof auditResourceSchema>;

export const auditEventSchema = z.object({
  event_id: z.string().max(64),
  ts: z.string(),
  event: z.string(),
  user_id: z.string().nullable(),
  /** Actor as the verified token said when the event was written (display only). */
  actor_email: z.string().max(254).nullable().optional(),
  actor_role: z.string().max(64).nullable().optional(),
  actor_is_admin: z.boolean().nullable().optional(),
  resource: auditResourceSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).default({}),
  hash: z.string().max(128),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** Opaque cursor issued by the API; only sent back as a query parameter. */
export const auditCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const auditListSchema = z.object({
  items: z.array(auditEventSchema),
  next_cursor: auditCursorSchema.nullable(),
});
export type AuditList = z.infer<typeof auditListSchema>;

/** A submit rule the server found broken: a code and the items it refers to, never content. */
export const violationSchema = z.object({
  code: z.string().max(64),
  field: z.string().max(64),
  items: z.array(z.string().max(256)).max(100),
});
export type ApiViolation = z.infer<typeof violationSchema>;

export const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  /** Only on `422 validation_failed` of the agents API. */
  violations: z.array(violationSchema).max(100).optional(),
});
