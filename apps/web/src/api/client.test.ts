import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from './client';
import { ApiError, NotAuthenticatedError, sessionUnavailableError } from './errors';
import type { PlaygroundEvent } from './playgroundEvents';

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setup(fetchImpl: typeof fetch, token: string | null = 'access-token') {
  const onUnauthorized = vi.fn();
  const client = createApiClient({
    basePath: '/api',
    getAccessToken: () => Promise.resolve(token),
    onUnauthorized,
    fetchImpl,
  });
  return { client, onUnauthorized };
}

describe('createApiClient', () => {
  it('sends the access token as a Bearer header without cookies', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse({
          user_id: 'u1',
          role: 'bu-lead',
          business_unit: 'retail',
          is_admin: false,
          groups: ['bu-lead', 'bu-retail'],
          can: { create_agent: false },
        }),
      ),
    );
    const { client } = setup(fetchMock);
    await expect(client.getMe()).resolves.toMatchObject({ user_id: 'u1', role: 'bu-lead' });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/me');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-token');
    expect(init?.credentials).toBe('omit');
  });

  it('accepts a user with groups and no FinOps role', async () => {
    const me = {
      user_id: 'u2',
      role: null,
      business_unit: null,
      is_admin: false,
      groups: ['mango-agent-creator', 'people'],
      can: { create_agent: true },
    };
    const { client } = setup(() => Promise.resolve(jsonResponse(me)));
    // A mango-api from before memory_enabled: the memory is off (D122).
    await expect(client.getMe()).resolves.toEqual({ ...me, memory_enabled: false });
  });

  it.each([
    [{ groups: ['<img src=x onerror=alert(1)>'] }],
    [{ groups: 'people' }],
    [{ groups: undefined }],
    [{ can: { create_agent: 'yes' } }],
    [{ can: undefined }],
    [{ role: 'superadmin' }],
  ])('rejects a malformed /api/me %j', async (patch) => {
    const me = {
      user_id: 'u2',
      role: null,
      business_unit: null,
      is_admin: false,
      groups: ['people'],
      can: { create_agent: false },
      ...patch,
    };
    const { client } = setup(() => Promise.resolve(jsonResponse(me)));
    await expect(client.getMe()).rejects.toThrow();
  });

  it('does not call the API without a session', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { client } = setup(fetchMock, null);
    await expect(client.getMe()).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an outage', sessionUnavailableError(), { status: 503, code: 'session_unavailable' }],
    [
      'a rate limit',
      sessionUnavailableError({ rateLimited: true, retryAfter: 90 }),
      { status: 429, code: 'rate_limited', retryAfter: 90 },
    ],
    ['the network', new TypeError('Failed to fetch'), { name: 'TypeError' }],
  ])(
    'does not report "no session" when the renewal failed by %s',
    async (_cause, failure, expected) => {
      const fetchMock = vi.fn<typeof fetch>();
      const onUnauthorized = vi.fn();
      const client = createApiClient({
        basePath: '/api',
        getAccessToken: () => Promise.reject(failure),
        onUnauthorized,
        fetchImpl: fetchMock,
      });
      for (const call of [
        () => client.getMe(),
        () => client.createTurn({ conversationId: null, message: 'hola' }),
      ]) {
        const error = await call().catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(NotAuthenticatedError);
        expect(error).toMatchObject(expected);
      }
      // Nothing was sent, and nobody was told to drop the session.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it.each([503, 429, 403])(
    'keeps the session when the API answers %i: only a 401 drops it',
    async (status) => {
      const { client, onUnauthorized } = setup(() =>
        Promise.resolve(jsonResponse({ error: { code: 'x', message: 'x' } }, status)),
      );
      await expect(client.getMe()).rejects.toMatchObject({ status });
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it('maps the contract error body to ApiError and signals 401', async () => {
    const { client, onUnauthorized } = setup(() =>
      Promise.resolve(jsonResponse({ error: { code: 'unauthorized', message: 'bad token' } }, 401)),
    );
    const error = await client.listConversations().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('rejects responses that do not match the contract', async () => {
    const { client } = setup(() => Promise.resolve(jsonResponse({ items: [{ nope: true }] })));
    await expect(client.listConversations()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses conversation IDs that could alter the request path', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { client } = setup(fetchMock);
    await expect(client.getConversation('../admin/audit')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clamps the audit limit and sends the page, range and filter as query parameters', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ items: [], next_cursor: 'abc_-1' })),
    );
    const { client } = setup(fetchMock);
    const page = await client.listAuditEvents({ limit: 10_000 });
    expect(page.next_cursor).toBe('abc_-1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/audit?limit=200');
    await client.listAuditEvents({
      limit: 20,
      cursor: 'abc_-1',
      since: new Date('2026-09-01T00:00:00Z'),
      until: new Date('2026-09-02T00:00:00Z'),
      excludeReads: true,
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/admin/audit?limit=20&cursor=abc_-1&since=2026-09-01T00%3A00%3A00.000Z&until=2026-09-02T00%3A00%3A00.000Z&exclude=reads',
    );
  });

  it('never sends a cursor that could alter the query', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const { client } = setup(fetchMock);
    await expect(client.listAuditEvents({ cursor: 'a&limit=1' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an audit page with a malformed cursor', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ items: [], next_cursor: '../x' })),
    );
    const { client } = setup(fetchMock);
    await expect(client.listAuditEvents()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('withdraws a change without a reason', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ version: 1, units: {}, pending: [] })),
    );
    const { client } = setup(fetchMock);
    await client.withdrawBusinessUnitChange('a'.repeat(32));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/admin/business-units/changes/${'a'.repeat(32)}/withdraw`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    await expect(client.withdrawBusinessUnitChange('../x')).rejects.toThrow();
  });

  it('exposes Retry-After of a 429 in seconds', async () => {
    const limited = (value: string | null) =>
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'x' } }), {
        status: 429,
        headers: value === null ? {} : { 'Retry-After': value },
      });
    for (const [header, expected] of [
      ['37', 37],
      ['0', null],
      ['99999', null],
      ['Wed, 21 Oct 2015 07:28:00 GMT', null],
      [null, null],
    ] as const) {
      const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(limited(header)));
      const { client } = setup(fetchMock);
      await expect(client.runConnectivityCheck()).rejects.toMatchObject({
        status: 429,
        code: 'rate_limited',
        retryAfter: expected,
      });
    }
  });

  describe('chat turns (D120)', () => {
    const CONVERSATION = 'a'.repeat(32);
    const TURN = 'b'.repeat(32);

    it('posts only conversation_id and the trimmed message without an agent', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(jsonResponse({ conversation_id: CONVERSATION, turn_id: TURN })),
      );
      const { client } = setup(fetchMock);
      const created = await client.createTurn({
        conversationId: null,
        message: '  ¿Cuánto gastamos?  ',
      });
      expect(created).toEqual({ conversationId: CONVERSATION, turnId: TURN });
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('/api/chat/turns');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual({
        conversation_id: null,
        message: '¿Cuánto gastamos?',
        // The generated client fills the default of the contract (D116 (11)).
        attachments: [],
      });
    });

    it('sends the agent of a new conversation and the chosen model, and nothing else', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(jsonResponse({ conversation_id: CONVERSATION, turn_id: TURN })),
      );
      const { client } = setup(fetchMock);
      await client.createTurn({
        conversationId: null,
        agentId: 'abcdefghijklmnop',
        model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        message: 'hola',
        // Never part of the contract: prompt, tools and limits come from the published version.
        ...({ system_prompt: 'x', tools: ['*'] } as object),
      });
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
        conversation_id: null,
        message: 'hola',
        agent_id: 'abcdefghijklmnop',
        model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        attachments: [],
      });
    });

    it('rejects an agent id, a model or a message out of range before calling the API', async () => {
      const fetchMock = vi.fn<typeof fetch>();
      const { client } = setup(fetchMock);
      const base = { conversationId: null, message: 'hola' };
      for (const agentId of ['../me', 'Fin Ops', 'x'.repeat(17), 'a']) {
        await expect(client.createTurn({ ...base, agentId })).rejects.toThrow();
      }
      for (const model of ['a b', '<script>', 'x'.repeat(129)]) {
        await expect(client.createTurn({ ...base, agentId: 'finops', model })).rejects.toThrow();
      }
      for (const message of ['   ', 'x'.repeat(4001)]) {
        await expect(client.createTurn({ ...base, message })).rejects.toMatchObject({
          status: 422,
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces 402 budget_exceeded as ApiError', async () => {
      const { client } = setup(() =>
        Promise.resolve(
          jsonResponse({ error: { code: 'budget_exceeded', message: 'Budget exceeded' } }, 402),
        ),
      );
      await expect(
        client.createTurn({ conversationId: CONVERSATION, message: 'hola' }),
      ).rejects.toMatchObject({ status: 402, code: 'budget_exceeded' });
    });

    it('reads a stream from a bounded offset and never with a malformed turn id', async () => {
      const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(sseResponse([])));
      const { client } = setup(fetchMock);
      const signal = new AbortController().signal;
      await client.openTurnStream(TURN, 7, signal);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe(`/api/chat/turns/${TURN}/stream?after=7`);
      expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream');
      expect(() => client.openTurnStream('../x', 0, signal)).toThrow();
      expect(() => client.openTurnStream(TURN, -1, signal)).toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('tells the turn in flight of a conversation, or none (R3b)', async () => {
      const fetchMock = vi.fn<typeof fetch>((input) =>
        Promise.resolve(
          jsonResponse({
            turn: (input as string).includes(CONVERSATION)
              ? { turn_id: TURN, state: 'running' }
              : null,
          }),
        ),
      );
      const { client } = setup(fetchMock);
      await expect(client.conversationTurn(CONVERSATION)).resolves.toEqual({
        turn_id: TURN,
        state: 'running',
      });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/conversations/${CONVERSATION}/turn`);
      await expect(client.conversationTurn('c'.repeat(32))).resolves.toBeNull();
      await expect(client.conversationTurn('../admin')).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('streamPlayground', () => {
    const base = {
      agentId: 'k3fq7zr2m5xw6n4a',
      version: 3,
      revision: 7,
      message: '  ¿Qué puedes hacer?  ',
      overrides: {},
    };

    it('posts only the fields of the contract and emits the parsed events', async () => {
      const fetchMock = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          sseResponse([
            'event: tool\ndata: {"name":"get_cost_and_usage","status":"started"}\n\n',
            'event: simulated_write\ndata: {"tool":"stop_instances"}\n\n',
            'event: done\ndata: {"stop_reason":"tool_use","usage":{"input_tokens":3,"output_tokens":4},"cost_usd":"0.0010","duration_ms":1200,"flags":{"guardrail":false,"token_cap":false,"time_limit":false,"iteration_limit":false}}\n\n',
          ]),
        ),
      );
      const { client } = setup(fetchMock);
      const events: PlaygroundEvent[] = [];
      await client.streamPlayground({
        ...base,
        overrides: { systemPrompt: 'Nuevo', model: 'model.fast', temperature: 0.4 },
        onEvent: (event) => events.push(event),
        // Never part of the contract: tools, limits and access come from the stored version.
        ...({ tools: ['*'], limits: {} } as object),
      });
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('/api/playground/runs');
      expect(JSON.parse(init?.body as string)).toEqual({
        agent_id: 'k3fq7zr2m5xw6n4a',
        version: 3,
        revision: 7,
        message: '¿Qué puedes hacer?',
        overrides: { system_prompt: 'Nuevo', model: 'model.fast', temperature: 0.4 },
      });
      expect(events.map((event) => event.type)).toEqual(['tool', 'simulated_write', 'done']);
    });

    it('leaves out the revision of a published version and the changes not made', async () => {
      const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(sseResponse([])));
      const { client } = setup(fetchMock);
      await client.streamPlayground({ ...base, revision: null, onEvent: vi.fn() });
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
        agent_id: 'k3fq7zr2m5xw6n4a',
        version: 3,
        message: '¿Qué puedes hacer?',
        overrides: {},
      });
    });

    it('refuses what the API would reject before calling it', async () => {
      const fetchMock = vi.fn<typeof fetch>();
      const { client } = setup(fetchMock);
      const onEvent = vi.fn();
      for (const request of [
        { ...base, agentId: '../me' },
        { ...base, version: 0 },
        { ...base, revision: 1.5 },
        { ...base, message: '   ' },
        { ...base, message: 'x'.repeat(4001) },
        { ...base, overrides: { temperature: 2 } },
        { ...base, overrides: { model: '<script>' } },
      ]) {
        await expect(client.streamPlayground({ ...request, onEvent })).rejects.toThrow();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('surfaces a 429 with its Retry-After', async () => {
      const { client } = setup(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'x' } }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '42' },
          }),
        ),
      );
      await expect(client.streamPlayground({ ...base, onEvent: vi.fn() })).rejects.toMatchObject({
        status: 429,
        code: 'rate_limited',
        retryAfter: 42,
      });
    });
  });
});
