import { describe, expect, it } from 'vitest';

import { approval, selfApproval } from '../pages/approvals/testFixtures';
import { feed, type ScriptEvent } from '../test/turnEvents';

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
    state = feed(state, 'a', { type: 'conversation', conversation_id: 'c1' });
    state = feed(state, 'a', { type: 'tool', name: 'get_cost_and_usage', status: 'started' });
    state = feed(state, 'a', { type: 'tool', name: 'get_cost_and_usage', status: 'completed' });
    state = feed(state, 'a', { type: 'delta', text: 'Hola ' });
    state = feed(state, 'a', { type: 'delta', text: 'mundo' });
    state = feed(state, 'a', {
      type: 'done',
      message_id: 'm',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
      cost_usd: '0.01',
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
      feed(state, 'a', { type: 'status', phase, ...(tool ? { tool } : {}) });
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
    state = feed(start(), 'a', {
      type: 'error',
      code: 'budget_exceeded',
      message: 'raw backend text',
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
    state = feed(state, 'a', { type: 'tool', name: 'get_cost_and_usage', status: 'started' }, 1000);
    state = feed(state, 'a', { type: 'tool', name: 'get_anomalies', status: 'started' }, 1100);
    state = feed(
      state,
      'a',
      { type: 'tool', name: 'get_cost_and_usage', status: 'completed' },
      2250,
    );
    state = feed(state, 'a', { type: 'tool', name: 'get_anomalies', status: 'error' }, 1400);
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

describe('fromApiMessage · how a cut answer ended (R3b)', () => {
  const stored = (stop_code: string | null) =>
    fromApiMessage({
      message_id: 'm1',
      role: 'assistant',
      content: 'Lo que alcanzó',
      created_at: '2026-11-07T12:00:00Z',
      tools: [],
      stop_code,
    });

  it('says «Detener» and a turn Mango lost from the stored stop code', () => {
    expect(stored('cancelled').status).toBe('stopped');
    expect(stored('turn_interrupted').status).toBe('interrupted');
    // None, or one this client does not know yet: a plain answer.
    expect(stored(null).status).toBe('done');
    expect(stored('later_reason').status).toBe('done');
  });
});

describe('fromApiMessage · the files of a question (D116)', () => {
  it('keeps id, name and size, and says which ones are gone', () => {
    const message = fromApiMessage({
      message_id: 'm1',
      role: 'user',
      content: '(archivos adjuntos)',
      created_at: '2026-11-07T12:00:00Z',
      tools: [],
      attachments: [
        {
          file_id: '01HZZZZZZZZZZZZZZZZZZZZZ01',
          name: 'a.csv',
          kind: 'csv',
          size_bytes: 9,
          gone: true,
        },
      ],
    });
    expect(message.attachments).toEqual([
      { fileId: '01HZZZZZZZZZZZZZZZZZZZZZ01', name: 'a.csv', size: 9, gone: true },
    ]);
  });

  it('a question sent with files shows them', () => {
    const files = [{ fileId: 'f1', name: 'a.csv', size: 9, gone: false }];
    const state = chatReducer(initialChatState, {
      type: 'send',
      userId: 'u1',
      assistantId: 'a1',
      text: 'Hola',
      attachments: files,
    });
    expect(state.messages[0]?.attachments).toEqual(files);
  });
});

describe('chatReducer · a turn in flight read again (round 40)', () => {
  const question = {
    id: 'q',
    role: 'user' as const,
    content: 'EC2',
    tools: [],
    status: 'done' as const,
  };

  it('marks the question of another tab only when asked, and only a question', () => {
    const opened = chatReducer(initialChatState, {
      type: 'reset',
      conversationId: 'c1',
      messages: [question],
    });
    const other = chatReducer(opened, { type: 'resume', assistantId: 'a', otherTab: true });
    expect(other.messages.map((m) => [m.role, m.fromOtherTab, m.status])).toEqual([
      ['user', true, 'done'],
      ['assistant', undefined, 'streaming'],
    ]);
    const mine = chatReducer(opened, { type: 'resume', assistantId: 'a' });
    expect(mine.messages[0]?.fromOtherTab).toBeUndefined();
  });
});

describe('dangling tool calls', () => {
  function withRunningTool(): ChatState {
    return feed(start(), 'a', { type: 'tool', name: 'get_cost_and_usage', status: 'started' });
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
    const afterError = feed(withRunningTool(), 'a', {
      type: 'error',
      code: 'upstream_error',
      message: 'x',
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
    const state = feed(withRunningTool(), 'a', {
      type: 'done',
      message_id: 'm',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      cost_usd: '0',
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
    const state = feed(start(), 'a', { type: 'approval', approval: request });
    expect(state.messages[1]?.approvals).toEqual([request]);
    expect(state.messages[0]?.approvals).toBeUndefined();
  });

  it('replaces a request wherever it is shown when it changes', () => {
    const request = selfApproval();
    let state = feed(start(), 'a', { type: 'approval', approval: request });
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
  const play = (state: ChatState, events: ScriptEvent[]) =>
    events.reduce((current, event) => feed(current, 'a', event), state);
  const event = (payload: ScriptEvent) => payload;
  const stepsOf = (state: ChatState) =>
    (state.messages[1]?.steps ?? []).map((step) => [step.kind, step.tool ?? null, step.status]);

  it('lists what the agent did in order, with tools in parallel and one that fails', () => {
    const state = play(start(), [
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
    const state = play(start(), [
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
    const running = play(start(), [
      event({ type: 'status', phase: 'thinking' }),
      event({ type: 'status', phase: 'writing' }),
    ]);
    const ended = feed(running, 'a', event({ ...done, stop_reason: 'end_turn' }));
    expect([stepsOf(ended), ended.messages[1]?.guardrail]).toEqual([[], undefined]);
    const cut = feed(running, 'a', event({ ...done, stop_reason: 'guardrail_intervened' }));
    expect(cut.messages[1]?.guardrail).toBe(true);
    const stopped = chatReducer(running, { type: 'finish', assistantId: 'a', status: 'stopped' });
    expect(stepsOf(stopped)).toEqual([]);
  });

  const capDone = {
    type: 'done',
    message_id: 'm',
    usage: { input_tokens: 1, output_tokens: 1 },
    cost_usd: '0',
  } as const;

  it('keeps an answer cut at its token cap and marks it incomplete (design round 34)', () => {
    const written = play(start(), [event({ type: 'delta', text: 'Una guía que se cor' })]);
    const ended = feed(written, 'a', event({ ...capDone, stop_reason: 'end_turn' })).messages[1];
    const capped = feed(written, 'a', event({ ...capDone, stop_reason: 'max_tokens' })).messages[1];
    expect(ended?.truncated).toBeUndefined();
    expect(capped).toEqual({ ...ended, truncated: { kind: 'tokens' } });
    expect([capped?.status, capped?.content]).toEqual(['done', 'Una guía que se cor']);
  });

  it('says the cap cut a tool call, by the name the progress gave (never the model)', () => {
    const calling = play(start(), [
      event({ type: 'delta', text: 'Voy a consultar' }),
      event({ type: 'tool', name: 'model_wrote_this', status: 'started' }),
      event({ type: 'status', phase: 'tool', tool: 'get_cost_and_usage' }),
    ]);
    const capped = feed(calling, 'a', event({ ...capDone, stop_reason: 'max_tokens' }));
    expect(capped.messages[1]?.truncated).toEqual({ kind: 'tool', tool: 'get_cost_and_usage' });
    // A tool the progress did not name (not of the published version): no name at all.
    const unnamed = play(start(), [
      event({ type: 'tool', name: 'evil', status: 'started' }),
      event({ type: 'status', phase: 'tool' }),
    ]);
    expect(
      feed(unnamed, 'a', event({ ...capDone, stop_reason: 'max_tokens' })).messages[1]?.truncated,
    ).toEqual({ kind: 'tool', tool: null });
    // A tool that answered before the cut is not the one cut.
    const answered = play(start(), [
      event({ type: 'tool', name: 'get_cost_and_usage', status: 'started' }),
      event({ type: 'tool', name: 'get_cost_and_usage', status: 'completed' }),
      event({ type: 'delta', text: 'Según los datos' }),
    ]);
    expect(
      feed(answered, 'a', event({ ...capDone, stop_reason: 'max_tokens' })).messages[1]?.truncated,
    ).toEqual({ kind: 'tokens' });
  });

  it('keeps when a turn refused with a 429 may be retried', () => {
    const state = chatReducer(start(), {
      type: 'finish',
      assistantId: 'a',
      status: 'error',
      errorKey: 'errors.rate_limited',
      retryAt: 1234,
    });
    expect([state.messages[1]?.errorKey, state.messages[1]?.retryAt]).toEqual([
      'errors.rate_limited',
      1234,
    ]);
    expect(errorKeyForCode('http_429', 429)).toBe('errors.rate_limited');
    expect(errorKeyForCode('rate_limited')).toBe('errors.rate_limited');
  });
});

describe('chatReducer · knowledge searches (D88 (44))', () => {
  const hr = (document: string, page?: number) => ({
    knowledge_base: 'Políticas de RH',
    document,
    ...(page === undefined ? {} : { page }),
  });

  it('keeps each search and each source once, in order, as the stored message does', () => {
    let state = start();
    state = feed(state, 'a', {
      type: 'knowledge',
      knowledge_bases: ['Políticas de RH'],
      count: 3,
      sources: [hr('Vacaciones.pdf', 3), hr('Handbook.pdf')],
    });
    state = feed(state, 'a', {
      type: 'knowledge',
      knowledge_bases: ['Políticas de RH'],
      count: 1,
      sources: [hr('Vacaciones.pdf', 3), hr('Beneficios.pdf', 7)],
    });
    const message = state.messages.at(-1);
    expect(message?.searches).toEqual([
      { knowledgeBases: ['Políticas de RH'], count: 3 },
      { knowledgeBases: ['Políticas de RH'], count: 1 },
    ]);
    expect(message?.citations).toEqual([
      { knowledgeBase: 'Políticas de RH', document: 'Vacaciones.pdf', page: 3 },
      { knowledgeBase: 'Políticas de RH', document: 'Handbook.pdf', page: null },
      { knowledgeBase: 'Políticas de RH', document: 'Beneficios.pdf', page: 7 },
    ]);
  });

  it('restores the sources of a stored answer', () => {
    const message = fromApiMessage({
      message_id: 'm',
      role: 'assistant',
      content: 'Son 15 días.',
      created_at: '2026-10-23T10:00:00Z',
      tools: [],
      citations: [{ knowledge_base: 'RH', document: 'a.pdf', page: null }],
    });
    expect(message.citations).toEqual([{ knowledgeBase: 'RH', document: 'a.pdf', page: null }]);
  });
});

describe('chatReducer · remote connections (D98 (20))', () => {
  it('keeps one card per registration, timed by the wall clock', () => {
    const event = { type: 'remote_connection_required', registration_id: 'abcdefghij23' } as const;
    let state = feed(start(), 'a', event, 5);
    state = feed(state, 'a', event, 9);
    const message = state.messages.find((item) => item.id === 'a');
    expect(message?.connectionRequired).toEqual(['abcdefghij23']);
    // Not the performance clock of `receivedAt`: the card counts down real minutes.
    expect(message?.connectionAt).toBeGreaterThan(1_000_000_000_000);
  });

  it('reads the stored cards and sources of a message', () => {
    const message = fromApiMessage({
      message_id: 'm',
      role: 'assistant',
      content: 'ok',
      created_at: '2026-10-27T00:00:00Z',
      tools: [],
      connection_required: ['abcdefghij23'],
      remote_sources: ['klmnopqrst45'],
    });
    expect(message.connectionRequired).toEqual(['abcdefghij23']);
    expect(message.remoteSources).toEqual(['klmnopqrst45']);
  });

  it('takes the sources of the live turn from its done event, as a reload would', () => {
    const done = {
      type: 'done',
      message_id: 'm',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      cost_usd: '0',
    } as const;
    const at = (event: ScriptEvent) =>
      feed(start(), 'a', event, 1).messages.find((item) => item.id === 'a');
    expect(at({ ...done, remote_sources: ['klmnopqrst45'] })?.remoteSources).toEqual([
      'klmnopqrst45',
    ]);
    // An answer that read no remote service (or an older API) keeps no sources.
    expect(at({ ...done, remote_sources: [] })?.remoteSources).toBeUndefined();
    expect(at(done)?.remoteSources).toBeUndefined();
  });
});
