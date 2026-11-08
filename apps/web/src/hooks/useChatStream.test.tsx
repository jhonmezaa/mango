import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ScriptEvent } from '../test/turnEvents';
import type { ApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { turnsApi, type TurnScriptRequest } from '../test/turnsApi';
import type { DisplayMessage } from './chatState';
import { useChatStream } from './useChatStream';

const TARGET = { agentId: 'finops', model: null };
const CONVERSATION = 'c1';

/** A script whose turn waits for `finish`, after the events given. */
function pendingScript(events: ScriptEvent[]) {
  const noop = (): void => undefined;
  const control: { emit: (event: ScriptEvent) => void; finish: () => void } = {
    emit: noop,
    finish: noop,
  };
  const turnScript = vi.fn(
    ({ onEvent }: TurnScriptRequest) =>
      new Promise<void>((resolve) => {
        onEvent({ type: 'conversation', conversation_id: CONVERSATION });
        events.forEach(onEvent);
        control.emit = onEvent;
        control.finish = () => {
          onEvent({ type: 'delta', text: ' y listo.' });
          onEvent({
            type: 'done',
            message_id: 'm1',
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            cost_usd: '0.01',
          });
          resolve();
        };
      }),
  );
  return { turnScript, control };
}

function setup(api: ApiClient) {
  const callbacks = {
    onConversationStarted: vi.fn(),
    onTurnFinished: vi.fn(),
    onTurnCompleted: vi.fn(),
    onUnauthenticated: vi.fn(),
    onSessionEndedDuringTurn: vi.fn(),
    onBusy: vi.fn(),
  };
  const hook = renderHook(() => useChatStream({ api, ...callbacks }));
  return { hook, callbacks };
}

const last = (messages: DisplayMessage[]) => messages.at(-1);

describe('useChatStream (v1)', () => {
  it('creates the turn, reads it and ends with its answer', async () => {
    const { turnScript, control } = pendingScript([{ type: 'delta', text: 'Gastaron USD 10' }]);
    const api = turnsApi({ turnScript }) as unknown as ApiClient;
    const { hook, callbacks } = setup(api);
    await act(() => hook.result.current.send('Hola', TARGET));
    expect(callbacks.onConversationStarted).toHaveBeenCalledWith(CONVERSATION);
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.content).toBe('Gastaron USD 10');
    });
    expect(hook.result.current.isStreaming).toBe(true);
    act(() => {
      control.finish();
    });
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.status).toBe('done');
    });
    expect(last(hook.result.current.state.messages)?.content).toBe('Gastaron USD 10 y listo.');
    expect(hook.result.current.isStreaming).toBe(false);
    expect(callbacks.onTurnCompleted).toHaveBeenCalledWith(false);
  });

  it('reads a turn in flight again when its conversation opens again (round 40)', async () => {
    const { turnScript, control } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ turnScript }) as unknown as ApiClient;
    const { hook } = setup(api);
    await act(() => hook.result.current.send('Hola', TARGET));
    // The person leaves the conversation: the turn goes on in Mango.
    act(() => {
      hook.result.current.reset(null);
    });
    expect(hook.result.current.isStreaming).toBe(false);
    // Back to it: the history has the question and no answer yet.
    const question: DisplayMessage = {
      id: 'q',
      role: 'user',
      content: 'Hola',
      tools: [],
      status: 'done',
    };
    act(() => {
      hook.result.current.reset(CONVERSATION, [question]);
    });
    // The API says the turn of the conversation that is in flight (R3b): read from its start.
    await waitFor(() => {
      expect(hook.result.current.isStreaming).toBe(true);
    });
    expect(last(hook.result.current.state.messages)?.fromOtherTab).toBeUndefined();
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.content).toBe('Gastaron');
    });
    act(() => {
      control.finish();
    });
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.status).toBe('done');
    });
    expect(hook.result.current.state.messages.map((m) => m.content)).toEqual([
      'Hola',
      'Gastaron y listo.',
    ]);
    // Once answered, opening it again reads nothing.
    await act(async () => {
      hook.result.current.reset(CONVERSATION, [question]);
      await Promise.resolve();
    });
    expect(hook.result.current.isStreaming).toBe(false);
  });

  it('reads nothing when the conversation has no turn in flight, nor while it loads', async () => {
    const { turnScript, control } = pendingScript([]);
    const api = turnsApi({ turnScript });
    const asked = vi.spyOn(api, 'conversationTurn');
    const { hook } = setup(api as unknown as ApiClient);
    await act(() => hook.result.current.send('Hola', TARGET));
    act(() => {
      control.finish();
    });
    await waitFor(() => {
      expect(hook.result.current.isStreaming).toBe(false);
    });
    // While its history loads, nothing is asked.
    act(() => {
      hook.result.current.reset(CONVERSATION);
    });
    expect(asked).not.toHaveBeenCalled();
    const history: DisplayMessage[] = [
      { id: 'q', role: 'user', content: 'Hola', tools: [], status: 'done' },
      { id: 'a', role: 'assistant', content: 'Listo', tools: [], status: 'done' },
    ];
    await act(async () => {
      hook.result.current.reset(CONVERSATION, history);
      await Promise.resolve();
    });
    expect(asked).toHaveBeenCalledWith(CONVERSATION);
    expect(hook.result.current.isStreaming).toBe(false);
    expect(hook.result.current.state.messages).toHaveLength(2);
  });

  it('follows the turn of another tab live, its question marked (round 40)', async () => {
    const { turnScript, control } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ turnScript }) as unknown as ApiClient;
    const { hook } = setup(api);
    // «The other tab»: a turn of the conversation in flight.
    await act(() => api.createTurn({ conversationId: CONVERSATION, message: 'EC2' }));
    const question: DisplayMessage = {
      id: 'q',
      role: 'user',
      content: 'EC2',
      tools: [],
      status: 'done',
    };
    act(() => {
      hook.result.current.reset(CONVERSATION, [question], { otherTab: true });
    });
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.content).toBe('Gastaron');
    });
    expect(hook.result.current.state.messages[0]?.fromOtherTab).toBe(true);
    act(() => {
      control.finish();
    });
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.status).toBe('done');
    });
  });

  it('does not follow a turn found for a conversation left meanwhile', async () => {
    const { turnScript } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ turnScript });
    let answer: (turn: { turn_id: string; state: 'running' }) => void = () => undefined;
    api.conversationTurn = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const { hook } = setup(api as unknown as ApiClient);
    act(() => {
      hook.result.current.reset(CONVERSATION, []);
    });
    act(() => {
      hook.result.current.reset(null);
    });
    await act(async () => {
      answer({ turn_id: 'turn1', state: 'running' });
      await Promise.resolve();
    });
    expect(hook.result.current.isStreaming).toBe(false);
    expect(hook.result.current.state.messages).toEqual([]);
  });

  it('gives the message back when another tab has a turn in flight (round 40)', async () => {
    const turnScript = vi.fn(({ onEvent }: TurnScriptRequest) => {
      onEvent({ type: 'conversation', conversation_id: CONVERSATION });
      onEvent({ type: 'error', code: 'conversation_busy', message: 'busy' });
      return Promise.resolve();
    });
    const api = turnsApi({ turnScript }) as unknown as ApiClient;
    const { hook, callbacks } = setup(api);
    await act(() => hook.result.current.send('¿Y RDS?', TARGET));
    await waitFor(() => {
      expect(callbacks.onBusy).toHaveBeenCalledWith('¿Y RDS?');
    });
    expect(hook.result.current.state.messages).toEqual([]);
    expect(hook.result.current.isStreaming).toBe(false);
  });

  it('says the turn was interrupted when Mango lost it after writing (round 40)', async () => {
    const turnScript = vi.fn(({ onEvent }: TurnScriptRequest) => {
      onEvent({ type: 'conversation', conversation_id: CONVERSATION });
      onEvent({ type: 'delta', text: 'Gastaron' });
      onEvent({ type: 'error', code: 'turn_interrupted', message: 'the answer was interrupted' });
      return Promise.resolve();
    });
    const api = turnsApi({ turnScript }) as unknown as ApiClient;
    const { hook } = setup(api);
    await act(() => hook.result.current.send('Hola', TARGET));
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.status).toBe('interrupted');
    });
    expect(last(hook.result.current.state.messages)?.content).toBe('Gastaron');
  });

  it('keeps a failure of the agent after it wrote as an error, with «Reintentar» (R3b)', async () => {
    const turnScript = vi.fn(({ onEvent }: TurnScriptRequest) => {
      onEvent({ type: 'conversation', conversation_id: CONVERSATION });
      onEvent({ type: 'delta', text: 'Gastaron' });
      onEvent({ type: 'error', code: 'upstream_error', message: 'the agent failed' });
      return Promise.resolve();
    });
    const { hook } = setup(turnsApi({ turnScript }) as unknown as ApiClient);
    await act(() => hook.result.current.send('Hola', TARGET));
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)).toMatchObject({
        status: 'error',
        errorKey: 'errors.upstream_error',
        content: 'Gastaron',
      });
    });
  });

  it('keeps an error that wrote nothing as an error', async () => {
    const turnScript = vi.fn(({ onEvent }: TurnScriptRequest) => {
      onEvent({ type: 'conversation', conversation_id: CONVERSATION });
      onEvent({ type: 'error', code: 'upstream_error', message: 'the agent failed' });
      return Promise.resolve();
    });
    const { hook } = setup(turnsApi({ turnScript }) as unknown as ApiClient);
    await act(() => hook.result.current.send('Hola', TARGET));
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)).toMatchObject({
        status: 'error',
        errorKey: 'errors.upstream_error',
      });
    });
  });

  it('«Cancelar» stops reading, tells the API and keeps what was written', async () => {
    const { turnScript } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ turnScript });
    const cancelTurn = vi.spyOn(api, 'cancelTurn');
    const { hook, callbacks } = setup(api as unknown as ApiClient);
    await act(() => hook.result.current.send('Hola', TARGET));
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.content).toBe('Gastaron');
    });
    act(() => {
      hook.result.current.stop();
    });
    expect(cancelTurn).toHaveBeenCalledWith('turn1');
    expect(last(hook.result.current.state.messages)).toMatchObject({
      status: 'stopped',
      content: 'Gastaron',
    });
    expect(hook.result.current.isStreaming).toBe(false);
    expect(callbacks.onTurnCompleted).not.toHaveBeenCalled();
  });

  it('reconnects after a cut and says so, without repeating the text', async () => {
    const { turnScript, control } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ turnScript });
    const open = api.openTurnStream.bind(api);
    let connections = 0;
    api.openTurnStream = vi.fn(async (turnId: string, after: number, signal: AbortSignal) => {
      connections += 1;
      if (connections === 1) {
        // The first connection drops as soon as it delivered what there was.
        const response = await open(turnId, after, signal);
        const reader = response.body?.getReader();
        const first = await reader?.read();
        return new Response(first?.value ?? null, { status: 200 });
      }
      if (connections === 2) throw new ApiError(502, 'http_502', 'Bad Gateway');
      return open(turnId, after, signal);
    });
    const { hook } = setup(api as unknown as ApiClient);
    await act(() => hook.result.current.send('Hola', TARGET));
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.connection).toEqual({
        kind: 'reconnecting',
        attempt: 2,
      });
    });
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.connection).toEqual({ kind: 'resumed' });
    });
    act(() => {
      control.finish();
    });
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.status).toBe('done');
    });
    expect(last(hook.result.current.state.messages)?.content).toBe('Gastaron y listo.');
    expect(last(hook.result.current.state.messages)?.connection).toBeUndefined();
  });

  it('gives up on an answer it cannot retry and reads again with «Volver a conectar»', async () => {
    const { turnScript, control } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ turnScript });
    const open = api.openTurnStream.bind(api);
    let refuse = true;
    api.openTurnStream = vi.fn((turnId: string, after: number, signal: AbortSignal) =>
      refuse ? Promise.reject(new ApiError(503, 'http_503', 'x')) : open(turnId, after, signal),
    );
    const { hook } = setup(api as unknown as ApiClient);
    await act(() => hook.result.current.send('Hola', TARGET));
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.connection).toEqual({ kind: 'failed' });
    });
    // «Cancelar» stays available meanwhile.
    expect(hook.result.current.isStreaming).toBe(true);
    refuse = false;
    act(() => {
      hook.result.current.reconnect();
    });
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.content).toBe('Gastaron');
    });
    act(() => {
      control.finish();
    });
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.status).toBe('done');
    });
  });

  it('ends the session with the turn notice when it ends while reconnecting (round 40)', async () => {
    const { turnScript } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ turnScript });
    const open = api.openTurnStream.bind(api);
    let connections = 0;
    api.openTurnStream = vi.fn(async (turnId: string, after: number, signal: AbortSignal) => {
      connections += 1;
      if (connections > 1) throw new ApiError(401, 'unauthenticated', 'invalid token');
      const response = await open(turnId, after, signal);
      const first = await response.body?.getReader().read();
      return new Response(first?.value ?? null, { status: 200 });
    });
    const { hook, callbacks } = setup(api as unknown as ApiClient);
    await act(() => hook.result.current.send('Hola', TARGET));
    await waitFor(() => {
      expect(callbacks.onSessionEndedDuringTurn).toHaveBeenCalledOnce();
    });
    expect(last(hook.result.current.state.messages)).toMatchObject({
      status: 'away',
      content: 'Gastaron',
    });
    expect(callbacks.onUnauthenticated).not.toHaveBeenCalled();
  });
});
