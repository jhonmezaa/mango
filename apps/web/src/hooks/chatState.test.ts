import { describe, expect, it } from 'vitest';

import { approval, selfApproval } from '../pages/approvals/testFixtures';

import {
  chatReducer,
  errorKeyForCode,
  fromApiMessage,
  initialChatState,
  type ChatState,
} from './chatState';

function start(): ChatState {
  return chatReducer(initialChatState, {
    type: 'send',
    userId: 'u',
    assistantId: 'a',
    text: 'hola',
    sentAt: '2026-09-30T12:03:00Z',
  });
}

describe('chatReducer', () => {
  it('builds the assistant message from stream events', () => {
    let state = start();
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: { type: 'conversation', conversation_id: 'c1' },
    });
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: { type: 'tool', name: 'get_cost_and_usage', status: 'started' },
    });
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: { type: 'tool', name: 'get_cost_and_usage', status: 'completed' },
    });
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: { type: 'delta', text: 'Hola ' },
    });
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: { type: 'delta', text: 'mundo' },
    });
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: {
        type: 'done',
        message_id: 'm',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
        cost_usd: '0.01',
      },
    });
    state = chatReducer(state, {
      type: 'finish',
      assistantId: 'a',
      status: 'error',
      errorKey: 'errors.streamInterrupted',
    });

    expect(state.conversationId).toBe('c1');
    expect(state.messages[0]).toMatchObject({ role: 'user', createdAt: '2026-09-30T12:03:00Z' });
    expect(state.messages[1]).toMatchObject({
      content: 'Hola mundo',
      status: 'done',
      tools: [{ name: 'get_cost_and_usage', status: 'completed' }],
      usage: { inputTokens: 1, outputTokens: 2, costUsd: '0.01' },
    });
  });

  it('keeps the latest live progress of the turn', () => {
    const status = (phase: string, tool?: string): ChatState =>
      chatReducer(state, {
        type: 'event',
        assistantId: 'a',
        event: { type: 'status', phase, ...(tool ? { tool } : {}) },
      });
    let state = start();
    expect(state.messages[1]?.progress).toBeUndefined();
    state = status('thinking');
    expect(state.messages[1]?.progress).toEqual({ phase: 'thinking' });
    state = status('tool', 'get_cost_and_usage');
    expect(state.messages[1]?.progress).toEqual({ phase: 'tool', tool: 'get_cost_and_usage' });
    state = status('tool_result');
    expect(state.messages[1]?.progress).toEqual({ phase: 'tool_result' });
    // A phase of a newer API is shown as plain thinking, and never touches the answer.
    state = status('planning', 'x');
    expect(state.messages[1]).toMatchObject({
      progress: { phase: 'thinking' },
      content: '',
      tools: [],
      status: 'streaming',
    });
    expect(state.messages[0]?.progress).toBeUndefined();
  });

  it('marks dangling streams as interrupted and maps error codes', () => {
    let state = chatReducer(start(), {
      type: 'finish',
      assistantId: 'a',
      status: 'error',
      errorKey: 'errors.streamInterrupted',
    });
    expect(state.messages[1]).toMatchObject({
      status: 'error',
      errorKey: 'errors.streamInterrupted',
    });
    state = chatReducer(start(), {
      type: 'event',
      assistantId: 'a',
      event: { type: 'error', code: 'budget_exceeded', message: 'raw backend text' },
    });
    expect(state.messages[1]).toMatchObject({
      status: 'error',
      errorKey: 'errors.budget_exceeded',
    });
    expect(errorKeyForCode('whatever', 402)).toBe('errors.budget_exceeded');
    expect(errorKeyForCode('whatever')).toBe('errors.generic');
  });
});

describe('tool call timing', () => {
  it('measures the duration between started and completed on the client clock', () => {
    let state = start();
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: { type: 'tool', name: 'get_cost_and_usage', status: 'started' },
      receivedAt: 1000,
    });
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: { type: 'tool', name: 'get_anomalies', status: 'started' },
      receivedAt: 1100,
    });
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: { type: 'tool', name: 'get_cost_and_usage', status: 'completed' },
      receivedAt: 2250,
    });
    state = chatReducer(state, {
      type: 'event',
      assistantId: 'a',
      event: { type: 'tool', name: 'get_anomalies', status: 'error' },
      receivedAt: 1400,
    });
    expect(state.messages[1]?.tools).toEqual([
      { name: 'get_cost_and_usage', status: 'completed', startedAt: 1000, durationMs: 1250 },
      { name: 'get_anomalies', status: 'error', startedAt: 1100, durationMs: 300 },
    ]);
  });
});

describe('fromApiMessage', () => {
  it('folds stored started/completed tool entries into one call per invocation', () => {
    const message = fromApiMessage({
      message_id: 'm',
      role: 'assistant',
      content: 'ok',
      created_at: '2026-09-29T00:00:00Z',
      tools: [
        { name: 'get_cost_forecast', status: 'started' },
        { name: 'get_cost_forecast', status: 'completed' },
        { name: 'get_anomalies', status: 'started' },
        { name: 'get_anomalies', status: 'error' },
      ],
    });
    expect(message.tools).toEqual([
      { name: 'get_cost_forecast', status: 'completed' },
      { name: 'get_anomalies', status: 'error' },
    ]);
  });
});

describe('dangling tool calls', () => {
  function withRunningTool(): ChatState {
    return chatReducer(start(), {
      type: 'event',
      assistantId: 'a',
      event: { type: 'tool', name: 'get_cost_and_usage', status: 'started' },
    });
  }

  it('settles a started tool when the user stops the turn', () => {
    const state = chatReducer(withRunningTool(), {
      type: 'finish',
      assistantId: 'a',
      status: 'stopped',
    });
    expect(state.messages[1]?.tools).toEqual([
      { name: 'get_cost_and_usage', status: 'interrupted' },
    ]);
  });

  it('settles a started tool on an error event and on a dangling stream', () => {
    const afterError = chatReducer(withRunningTool(), {
      type: 'event',
      assistantId: 'a',
      event: { type: 'error', code: 'upstream_error', message: 'x' },
    });
    expect(afterError.messages[1]?.tools[0]?.status).toBe('interrupted');

    const afterFinish = chatReducer(withRunningTool(), {
      type: 'finish',
      assistantId: 'a',
      status: 'error',
      errorKey: 'errors.streamInterrupted',
    });
    expect(afterFinish.messages[1]?.tools[0]?.status).toBe('interrupted');
  });

  it('settles a started tool left over when the turn is done', () => {
    const state = chatReducer(withRunningTool(), {
      type: 'event',
      assistantId: 'a',
      event: {
        type: 'done',
        message_id: 'm',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        cost_usd: '0',
      },
    });
    expect(state.messages[1]?.tools[0]?.status).toBe('interrupted');
  });

  it('settles a dangling started entry in stored history and keeps its timestamp', () => {
    const message = fromApiMessage({
      message_id: 'm1',
      role: 'assistant',
      content: 'respuesta',
      created_at: '2026-09-29T10:00:00Z',
      tools: [
        { name: 'get_cost_and_usage', status: 'started' },
        { name: 'get_cost_and_usage', status: 'completed' },
        { name: 'get_anomalies', status: 'started' },
      ],
    });
    expect(message.tools).toEqual([
      { name: 'get_cost_and_usage', status: 'completed' },
      { name: 'get_anomalies', status: 'interrupted' },
    ]);
    expect(message.createdAt).toBe('2026-09-29T10:00:00Z');
  });
});

describe('chatReducer · approvals (D27)', () => {
  it('attaches a request to the answer whose write call created it', () => {
    const request = selfApproval();
    const state = chatReducer(start(), {
      type: 'event',
      assistantId: 'a',
      event: { type: 'approval', approval: request },
    });
    expect(state.messages[1]?.approvals).toEqual([request]);
    expect(state.messages[0]?.approvals).toBeUndefined();
  });

  it('replaces a request wherever it is shown when it changes', () => {
    const request = selfApproval();
    let state = chatReducer(start(), {
      type: 'event',
      assistantId: 'a',
      event: { type: 'approval', approval: request },
    });
    const done = selfApproval({ status: 'executed' });
    state = chatReducer(state, { type: 'approval', approval: done });
    expect(state.messages[1]?.approvals).toEqual([done]);
    // A request this conversation does not show changes nothing.
    expect(chatReducer(state, { type: 'approval', approval: approval() })).toBe(state);
  });

  it('restores the requests of a stored message by id', () => {
    const request = selfApproval();
    const message = fromApiMessage(
      {
        message_id: 'm1',
        role: 'assistant',
        content: 'Lo preparo.',
        created_at: '2026-10-02T12:00:00Z',
        tools: [],
        approvals: [request.approval_id, 'f'.repeat(32)],
      },
      new Map([[request.approval_id, request]]),
    );
    // An id the API did not return (someone else's, or expired from the table) is dropped.
    expect(message.approvals).toEqual([request]);
  });
});

describe('chatReducer · steps of a turn in flight (design chat.jsx streamSteps)', () => {
  const feed = (state: ChatState, events: Parameters<typeof chatReducer>[1][]) =>
    events.reduce(chatReducer, state);
  const event = (payload: Extract<Parameters<typeof chatReducer>[1], { type: 'event' }>['event']) =>
    ({ type: 'event', assistantId: 'a', event: payload }) as const;
  const stepsOf = (state: ChatState) =>
    (state.messages[1]?.steps ?? []).map((step) => [step.kind, step.tool ?? null, step.status]);

  it('lists what the agent did in order, with tools in parallel and one that fails', () => {
    const state = feed(start(), [
      event({ type: 'status', phase: 'thinking' }),
      event({ type: 'tool', name: 'get_cost_and_usage', status: 'started' }),
      event({ type: 'status', phase: 'tool', tool: 'get_cost_and_usage' }),
      event({ type: 'tool', name: 'get_rightsizing_recommendations', status: 'started' }),
      event({ type: 'tool', name: 'get_rightsizing_recommendations', status: 'error' }),
      event({ type: 'tool', name: 'get_cost_and_usage', status: 'completed' }),
      event({ type: 'status', phase: 'tool_result' }),
      event({ type: 'status', phase: 'writing' }),
      event({ type: 'delta', text: 'Primera parte.' }),
    ]);
    expect(stepsOf(state)).toEqual([
      ['thinking', null, 'ok'],
      ['tool', 'get_cost_and_usage', 'ok'],
      ['tool', 'get_rightsizing_recommendations', 'failed'],
      ['tool_result', null, 'ok'],
      ['writing', null, 'running'],
    ]);
  });

  it('does not repeat a phase that is still running', () => {
    const state = feed(start(), [
      event({ type: 'status', phase: 'thinking' }),
      event({ type: 'status', phase: 'thinking' }),
    ]);
    expect(stepsOf(state)).toEqual([['thinking', null, 'running']]);
  });

  it('drops the steps once the turn is over, and marks an answer the guardrail cut', () => {
    const done = {
      type: 'done',
      message_id: 'm',
      usage: { input_tokens: 1, output_tokens: 1 },
      cost_usd: '0',
    } as const;
    const running = feed(start(), [
      event({ type: 'status', phase: 'thinking' }),
      event({ type: 'status', phase: 'writing' }),
    ]);
    const ended = chatReducer(running, event({ ...done, stop_reason: 'end_turn' }));
    expect([stepsOf(ended), ended.messages[1]?.guardrail]).toEqual([[], undefined]);
    const cut = chatReducer(running, event({ ...done, stop_reason: 'guardrail_intervened' }));
    expect(cut.messages[1]?.guardrail).toBe(true);
    const stopped = chatReducer(running, { type: 'finish', assistantId: 'a', status: 'stopped' });
    expect(stepsOf(stopped)).toEqual([]);
  });
});
