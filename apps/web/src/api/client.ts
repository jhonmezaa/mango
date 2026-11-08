import type { z } from 'zod';

import {
  REASON_MAX_LENGTH,
  adminUserIdSchema,
  budgetsSchema,
  businessUnitsSchema,
  changeCreatedSchema,
  changeIdSchema,
  connectivitySchema,
  organizationSchema,
  type Units,
} from './adminSchemas';
import { parseChatEvent, type ChatEvent } from './chatEvents';
import { chatFileIdSchema, chatFileLinkSchema, chatFileStatusSchema } from './codeSchemas';
import { ApiError, NotAuthenticatedError, apiErrorFromResponse } from './errors';
import { mfaResetCreatedSchema, mfaResetIdSchema, mfaResetListSchema } from './mfaResetSchemas';
import { createOperationCaller } from './operations';
import { parsePlaygroundEvent, type PlaygroundEvent } from './playgroundEvents';
import {
  MESSAGE_MAX_LENGTH,
  agentIdSchema,
  auditCursorSchema,
  auditListSchema,
  conversationIdSchema,
  conversationListSchema,
  conversationSchema,
  meSchema,
  turnIdSchema,
  modelIdSchema,
} from './schemas';
import { SseParser, type SseMessage } from './sse';

export interface ApiClientOptions {
  /** Same-origin path prefix, already validated by the runtime config (e.g. `/api`). */
  basePath: string;
  /**
   * Returns a fresh access token (never the ID token), or null when there is no session.
   * Rejects (`sessionUnavailableError`) when the session could not be renewed and nothing said
   * it ended: that failure reaches the caller as it is and no request goes out.
   */
  getAccessToken: () => Promise<string | null>;
  /** Called when the API answers 401 so the app can drop the session. */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}

export interface CreateTurnRequest {
  conversationId: string | null;
  /** Agent of a new conversation; an existing one keeps the agent of its first turn. */
  agentId?: string | null;
  /** One of the agent's allowed models; the API rejects any other (D22). */
  model?: string | null;
  message: string;
  /** Ids of the ready files of the question (D116 (11)); the API checks each one. */
  attachments?: readonly string[];
}

/** Highest `after` the API accepts (`MAX_STREAM_OFFSET`). */
export const MAX_STREAM_AFTER = 1_000_000;

/** `mango_api.memory.RecordId`: the id of a record of the agents' memory. */
const MEMORY_RECORD_ID = /^mem-[a-zA-Z0-9_-]{36,46}$/;

export interface StreamChatRequest {
  conversationId: string | null;
  /** Agent of a new conversation; an existing one keeps the agent of its first turn. */
  agentId?: string | null;
  /** One of the agent's allowed models; the API rejects any other (D22). */
  model?: string | null;
  message: string;
  signal?: AbortSignal;
  onEvent: (event: ChatEvent) => void;
}

/** One Playground test (D91): a stored version, one question and the three allowed changes. */
export interface StreamPlaygroundRequest {
  agentId: string;
  version: number;
  /** Revision of the draft on screen; the API answers 409 if it changed. Null for a published one. */
  revision: number | null;
  message: string;
  overrides: { systemPrompt?: string; model?: string; temperature?: number };
  signal?: AbortSignal;
  onEvent: (event: PlaygroundEvent) => void;
}

export interface AuditListOptions {
  /** 1..200 (API maximum). */
  limit?: number;
  /** `next_cursor` of the previous page. */
  cursor?: string | null;
  since?: Date | null;
  until?: Date | null;
  /** Hide allowed read-only authorization decisions (`exclude=reads`). */
  excludeReads?: boolean;
}

/** API page size bound for GET /api/admin/audit. */
export const AUDIT_PAGE_MAX = 200;

export type ApiClient = ReturnType<typeof createApiClient>;

/** Reads a text/event-stream body to its end, handing each event over as it completes. */
async function readEvents(response: Response, onMessage: (message: SseMessage) => void) {
  if (!response.body) throw new ApiError(502, 'empty_stream', 'Empty response stream');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const raw of parser.push(value)) onMessage(raw);
    }
    parser.end();
  } finally {
    reader.releaseLock();
  }
}

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  /**
   * `quiet401`: the caller decides what a 401 means (the stream of a turn says the session ended
   * with the turn's own notice); every other request lets the app drop the session at once.
   */
  async function authorizedFetch(
    path: string,
    init: RequestInit = {},
    { quiet401 = false }: { quiet401?: boolean } = {},
  ): Promise<Response> {
    const token = await options.getAccessToken();
    if (!token) throw new NotAuthenticatedError('No active session');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetchImpl(`${options.basePath}${path}`, {
      ...init,
      headers,
      // Bearer auth only: cookies are never attached, so CSRF does not apply (REACT-CSRF-001).
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    if (response.status === 401 && !quiet401) {
      options.onUnauthorized?.();
    }
    if (!response.ok) throw await apiErrorFromResponse(response);
    return response;
  }

  async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await authorizedFetch(path, { headers: { Accept: 'application/json' } });
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ApiError(response.status, 'invalid_response', 'Unexpected response from the API');
    }
    return parsed.data;
  }

  /** JSON write with a validated response. Only the fields named by the contract are sent. */
  async function sendJson<T>(
    method: 'POST' | 'PUT',
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await authorizedFetch(path, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      throw new ApiError(response.status, 'invalid_response', 'Unexpected response from the API');
    }
    return parsed.data;
  }

  /** POST of a route that answers 204 (not in the generated client: it has no JSON response). */
  async function postNoContent(path: string, body: Record<string, string> = {}): Promise<void> {
    await authorizedFetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function checkReason(reason: string): string {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > REASON_MAX_LENGTH) {
      throw new ApiError(422, 'invalid_reason', 'Reason length out of range');
    }
    return trimmed;
  }

  // Path parameters are validated and encoded before they reach a URL.
  const userBudgetPath = (userId: string) =>
    `/admin/budgets/users/${encodeURIComponent(adminUserIdSchema.parse(userId))}`;
  const changePath = (changeId: string, action: 'approve' | 'reject' | 'withdraw') =>
    `/admin/business-units/changes/${encodeURIComponent(changeIdSchema.parse(changeId))}/${action}`;

  // Evals (D26): the request to stop requiring a suite, by its random id (32 hex).
  const evalChangePath = (changeId: string, action: 'approve' | 'reject' | 'withdraw') => {
    if (!/^[0-9a-f]{32}$/.test(changeId)) throw new ApiError(422, 'invalid_request', 'Invalid id');
    return `/evals/requirement-changes/${encodeURIComponent(changeId)}/${action}`;
  };

  const mfaResetPath = (changeId: string, action: 'approve' | 'reject' | 'withdraw') =>
    `/admin/mfa-resets/${encodeURIComponent(mfaResetIdSchema.parse(changeId))}/${action}`;

  function conversationPath(conversationId: string): string {
    const id = conversationIdSchema.parse(conversationId);
    return `/conversations/${encodeURIComponent(id)}`;
  }

  const chatFilePath = (conversationId: string, fileId: string) =>
    `${conversationPath(conversationId)}/files/${encodeURIComponent(chatFileIdSchema.parse(fileId))}`;

  const call = createOperationCaller((path, init) => authorizedFetch(path, init));

  return {
    /**
     * Any JSON route by its name in the generated client (packages/ts/api-client). New screens use
     * this; the methods below predate the generated client and keep their hand-written schemas.
     */
    call,
    getMe: () => getJson('/me', meSchema),
    /**
     * Forgets one record of the caller's memory (D122): 204, not in the generated client. The id
     * is checked against the API's pattern before it reaches a URL.
     */
    deleteMemoryRecord: async (recordId: string) => {
      if (!MEMORY_RECORD_ID.test(recordId)) {
        throw new ApiError(422, 'invalid_request', 'Invalid id');
      }
      await authorizedFetch(`/memory/${encodeURIComponent(recordId)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });
    },
    listConversations: async () => (await getJson('/conversations', conversationListSchema)).items,
    getConversation: async (conversationId: string) =>
      getJson(conversationPath(conversationId), conversationSchema),
    /** Where a file of the conversation is (C4): «Revisando el archivo…» until its scan says. */
    getChatFile: (conversationId: string, fileId: string) =>
      getJson(chatFilePath(conversationId, fileId), chatFileStatusSchema),
    /** A new link of 5 minutes to download a file, asked when the person clicks (D116). */
    chatFileLink: (conversationId: string, fileId: string) =>
      sendJson('POST', `${chatFilePath(conversationId, fileId)}/download`, {}, chatFileLinkSchema),
    /**
     * The bytes of an image of the conversation, for a `blob:` URL (CSP `img-src blob:`): only
     * PNG and JPEG, with the type the server declared; anything else is refused.
     */
    chatFileImage: async (conversationId: string, fileId: string, signal?: AbortSignal) => {
      const response = await authorizedFetch(`${chatFilePath(conversationId, fileId)}/content`, {
        headers: { Accept: 'image/png, image/jpeg' },
        ...(signal ? { signal } : {}),
      });
      const type = (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
      if (type !== 'image/png' && type !== 'image/jpeg') {
        throw new ApiError(response.status, 'invalid_response', 'Not an image');
      }
      return new Blob([await response.arrayBuffer()], { type });
    },
    /** One page of the audit log, newest first; `next_cursor` is null on the last page. */
    listAuditEvents: async (options: AuditListOptions = {}) => {
      const query = new URLSearchParams();
      const limit = Math.trunc(options.limit ?? 50);
      query.set('limit', String(Math.min(Math.max(limit, 1), AUDIT_PAGE_MAX)));
      if (options.cursor) query.set('cursor', auditCursorSchema.parse(options.cursor));
      if (options.since) query.set('since', options.since.toISOString());
      if (options.until) query.set('until', options.until.toISOString());
      if (options.excludeReads) query.set('exclude', 'reads');
      return getJson(`/admin/audit?${query.toString()}`, auditListSchema);
    },
    // Admin v0 (D17). The server authorizes every call; the UI gating is only UX.
    getBudgets: () => getJson('/admin/budgets', budgetsSchema),
    putBudgetDefaults: (body: {
      version: number;
      user_monthly_usd: string;
      agent_monthly_usd: string;
    }) =>
      sendJson(
        'PUT',
        '/admin/budgets/defaults',
        {
          version: body.version,
          user_monthly_usd: body.user_monthly_usd,
          agent_monthly_usd: body.agent_monthly_usd,
        },
        budgetsSchema,
      ),
    putUserBudget: (userId: string, body: { version: number; limit_usd: string | null }) =>
      sendJson(
        'PUT',
        userBudgetPath(userId),
        { version: body.version, limit_usd: body.limit_usd },
        budgetsSchema,
      ),
    getBusinessUnits: () => getJson('/admin/business-units', businessUnitsSchema),
    proposeBusinessUnits: (body: { base_version: number; units: Units; reason: string }) =>
      sendJson(
        'POST',
        '/admin/business-units/changes',
        { base_version: body.base_version, units: body.units, reason: checkReason(body.reason) },
        changeCreatedSchema,
      ),
    approveBusinessUnitChange: (changeId: string) =>
      sendJson('POST', changePath(changeId, 'approve'), {}, businessUnitsSchema),
    rejectBusinessUnitChange: (changeId: string, reason: string) =>
      sendJson(
        'POST',
        changePath(changeId, 'reject'),
        { reason: checkReason(reason) },
        businessUnitsSchema,
      ),
    /** The proposer withdraws their own pending change; no reason is sent. */
    withdrawBusinessUnitChange: async (changeId: string) =>
      sendJson('POST', changePath(changeId, 'withdraw'), {}, businessUnitsSchema),
    getOrganization: () => getJson('/admin/organization', organizationSchema),
    runConnectivityCheck: () =>
      sendJson('POST', '/admin/connectivity-check', {}, connectivitySchema),
    // MFA reset with dual approval (D20).
    listMfaResets: async () => (await getJson('/admin/mfa-resets', mfaResetListSchema)).items,
    // `identity_verified` is the proposer's declaration of an out-of-band identity check (D20);
    // the server rejects the request without it.
    proposeMfaReset: (email: string, reason: string, identityVerified: true) =>
      sendJson(
        'POST',
        '/admin/mfa-resets',
        {
          email: email.trim().toLowerCase(),
          reason: checkReason(reason),
          identity_verified: identityVerified,
        },
        mfaResetCreatedSchema,
      ),
    approveMfaReset: async (changeId: string) =>
      (await sendJson('POST', mfaResetPath(changeId, 'approve'), {}, mfaResetListSchema)).items,
    rejectMfaReset: async (changeId: string, reason: string) =>
      (
        await sendJson(
          'POST',
          mfaResetPath(changeId, 'reject'),
          { reason: checkReason(reason) },
          mfaResetListSchema,
        )
      ).items,
    approveEvalRequirement: (changeId: string) =>
      postNoContent(evalChangePath(changeId, 'approve')),
    /** The reason (1 to 500 characters) is required and goes to Auditoría (D26). */
    rejectEvalRequirement: (changeId: string, reason: string) =>
      postNoContent(evalChangePath(changeId, 'reject'), { reason: checkReason(reason) }),
    withdrawEvalRequirement: (changeId: string) =>
      postNoContent(evalChangePath(changeId, 'withdraw')),
    withdrawMfaReset: async (changeId: string) =>
      (await sendJson('POST', mfaResetPath(changeId, 'withdraw'), {}, mfaResetListSchema)).items,

    /**
     * POST /api/chat/turns (D120, D121 (2)): the turn is queued and its stream is read with
     * `openTurnStream`. Only the fields of the contract go out (TM-I2); the generated client
     * validates the body and the answer.
     */
    createTurn: async (
      request: CreateTurnRequest,
    ): Promise<{ conversationId: string; turnId: string }> => {
      const message = request.message.trim();
      if (message.length < 1 || message.length > MESSAGE_MAX_LENGTH) {
        throw new ApiError(422, 'invalid_message', 'Message length out of range');
      }
      const created = await call('createTurn', {
        body: {
          conversation_id: request.conversationId,
          message,
          ...(request.agentId ? { agent_id: agentIdSchema.parse(request.agentId) } : {}),
          ...(request.model ? { model: modelIdSchema.parse(request.model) } : {}),
          ...(request.attachments?.length ? { attachments: [...request.attachments] } : {}),
        },
      });
      return {
        conversationId: conversationIdSchema.parse(created.conversation_id),
        turnId: turnIdSchema.parse(created.turn_id),
      };
    },

    /**
     * One connection to GET /api/chat/turns/{turn}/stream?after=<n> (D120 (4)). Not in the
     * generated client (no JSON response). A 401 does not drop the session here: `followTurn`
     * reports it and the chat ends the session with the turn's notice.
     */
    openTurnStream: (turnId: string, after: number, signal: AbortSignal) => {
      if (!Number.isInteger(after) || after < 0 || after > MAX_STREAM_AFTER) {
        throw new ApiError(422, 'invalid_request', 'Stream offset out of range');
      }
      const id = encodeURIComponent(turnIdSchema.parse(turnId));
      return authorizedFetch(
        `/chat/turns/${id}/stream?after=${String(after)}`,
        { headers: { Accept: 'text/event-stream' }, signal },
        { quiet401: true },
      );
    },

    /**
     * The turn of a conversation that is queued or running, if any (R3b): what a reloaded page
     * or another tab follows live from `after=0`. Null when there is none.
     */
    conversationTurn: async (conversationId: string) =>
      (
        await call('conversationTurn', {
          path: { conversation_id: conversationIdSchema.parse(conversationId) },
        })
      ).turn,

    /** «Cancelar» (D121 (7)): POST /api/chat/turns/{turn}/cancel; idempotent. */
    cancelTurn: (turnId: string) =>
      call('cancelTurn', { path: { turn_id: turnIdSchema.parse(turnId) } }),

    /**
     * POST /api/chat and consume the SSE response with fetch + ReadableStream (EventSource cannot
     * send a POST body or the Authorization header). Resolves when the stream ends.
     */
    async streamChat(request: StreamChatRequest): Promise<void> {
      const message = request.message.trim();
      if (message.length < 1 || message.length > MESSAGE_MAX_LENGTH) {
        throw new ApiError(422, 'invalid_message', 'Message length out of range');
      }
      const init: RequestInit = {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        // Only the fields of the contract; the backend rejects anything else (TM-I2). The agent
        // and the model are choices among what the API already lets this user use: prompt,
        // tools and limits are never sent.
        body: JSON.stringify({
          conversation_id: request.conversationId,
          message,
          ...(request.agentId ? { agent_id: agentIdSchema.parse(request.agentId) } : {}),
          ...(request.model ? { model: modelIdSchema.parse(request.model) } : {}),
        }),
      };
      if (request.signal) init.signal = request.signal;
      const response = await authorizedFetch('/chat', init);
      await readEvents(response, (raw) => {
        const event = parseChatEvent(raw);
        if (event) request.onEvent(event);
      });
    },

    /**
     * POST /api/playground/runs, read like the chat stream. Only the fields of the contract go
     * out; the version is the stored one and the API checks who may edit it (D91).
     */
    async streamPlayground(request: StreamPlaygroundRequest): Promise<void> {
      const message = request.message.trim();
      if (message.length < 1 || message.length > MESSAGE_MAX_LENGTH) {
        throw new ApiError(422, 'invalid_message', 'Message length out of range');
      }
      const { systemPrompt, model, temperature } = request.overrides;
      const counter = (value: number | null) =>
        value === null || (Number.isInteger(value) && value >= 1 && value <= 1_000_000);
      const inRange = temperature === undefined || (temperature >= 0 && temperature <= 1);
      if (!counter(request.version) || !counter(request.revision) || !inRange) {
        throw new ApiError(422, 'invalid_request', 'Playground request out of range');
      }
      const init: RequestInit = {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentIdSchema.parse(request.agentId),
          version: request.version,
          ...(request.revision === null ? {} : { revision: request.revision }),
          message,
          overrides: {
            ...(systemPrompt === undefined ? {} : { system_prompt: systemPrompt }),
            ...(model === undefined ? {} : { model: modelIdSchema.parse(model) }),
            ...(temperature === undefined ? {} : { temperature }),
          },
        }),
      };
      if (request.signal) init.signal = request.signal;
      const response = await authorizedFetch('/playground/runs', init);
      await readEvents(response, (raw) => {
        const event = parsePlaygroundEvent(raw);
        if (event) request.onEvent(event);
      });
    },
  };
}
