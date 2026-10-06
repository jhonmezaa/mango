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
import { ApiError, NotAuthenticatedError, apiErrorFromResponse } from './errors';
import { mfaResetCreatedSchema, mfaResetIdSchema, mfaResetListSchema } from './mfaResetSchemas';
import { createOperationCaller } from './operations';
import {
  MESSAGE_MAX_LENGTH,
  agentIdSchema,
  auditCursorSchema,
  auditListSchema,
  conversationIdSchema,
  conversationListSchema,
  conversationSchema,
  meSchema,
  modelIdSchema,
} from './schemas';
import { SseParser } from './sse';

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

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
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
    if (response.status === 401) {
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

  const mfaResetPath = (changeId: string, action: 'approve' | 'reject' | 'withdraw') =>
    `/admin/mfa-resets/${encodeURIComponent(mfaResetIdSchema.parse(changeId))}/${action}`;

  function conversationPath(conversationId: string): string {
    const id = conversationIdSchema.parse(conversationId);
    return `/conversations/${encodeURIComponent(id)}`;
  }

  return {
    /**
     * Any JSON route by its name in the generated client (packages/ts/api-client). New screens use
     * this; the methods below predate the generated client and keep their hand-written schemas.
     */
    call: createOperationCaller(authorizedFetch),
    getMe: () => getJson('/me', meSchema),
    listConversations: async () => (await getJson('/conversations', conversationListSchema)).items,
    getConversation: async (conversationId: string) =>
      getJson(conversationPath(conversationId), conversationSchema),
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
    withdrawMfaReset: async (changeId: string) =>
      (await sendJson('POST', mfaResetPath(changeId, 'withdraw'), {}, mfaResetListSchema)).items,

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
      if (!response.body) throw new ApiError(502, 'empty_stream', 'Empty response stream');

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const raw of parser.push(value)) {
            const event = parseChatEvent(raw);
            if (event) request.onEvent(event);
          }
        }
        parser.end();
      } finally {
        reader.releaseLock();
      }
    },
  };
}
