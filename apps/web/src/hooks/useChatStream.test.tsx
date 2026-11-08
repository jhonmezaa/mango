import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatEvent } from '../api/chatEvents';
import type { ApiClient, StreamChatRequest } from '../api/client';
import { ApiError } from '../api/errors';
import { turnsApi } from '../test/turnsApi';
import type { DisplayMessage } from './chatState';
import { forgetTurnsInFlight, useChatStream } from './useChatStream';

const TARGET = { agentId: 'finops', model: null };
const CONVERSATION = 'c1';

/** A script whose turn waits for `finish`, after the events given. */
function pendingScript(events: ChatEvent[]) {
  const noop = (): void => undefined;
  const control: { emit: (event: ChatEvent) => void; finish: () => void } = {
    emit: noop,
    finish: noop,
  };
  const streamChat = vi.fn(
    ({ onEvent }: StreamChatRequest) =>
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
  return { streamChat, control };
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

afterEach(() => {
  forgetTurnsInFlight();
});

describe('useChatStream (v1)', () => {
  it('creates the turn, reads it and ends with its answer', async () => {
    const { streamChat, control } = pendingScript([{ type: 'delta', text: 'Gastaron USD 10' }]);
    const api = turnsApi({ streamChat }) as unknown as ApiClient;
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
    const { streamChat, control } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ streamChat }) as unknown as ApiClient;
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
    expect(hook.result.current.isStreaming).toBe(true);
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
    act(() => {
      hook.result.current.reset(CONVERSATION, [question]);
    });
    expect(hook.result.current.isStreaming).toBe(false);
  });

  it('does not read again a turn the loaded history already answers', async () => {
    const { streamChat } = pendingScript([]);
    const api = turnsApi({ streamChat }) as unknown as ApiClient;
    const { hook } = setup(api);
    await act(() => hook.result.current.send('Hola', TARGET));
    const history: DisplayMessage[] = [
      { id: 'q', role: 'user', content: 'Hola', tools: [], status: 'done' },
      { id: 'a', role: 'assistant', content: 'Listo', tools: [], status: 'done' },
    ];
    act(() => {
      hook.result.current.reset(CONVERSATION, history);
    });
    expect(hook.result.current.isStreaming).toBe(false);
    expect(hook.result.current.state.messages).toHaveLength(2);
  });

  it('gives the message back when another tab has a turn in flight (round 40)', async () => {
    const streamChat = vi.fn(({ onEvent }: StreamChatRequest) => {
      onEvent({ type: 'conversation', conversation_id: CONVERSATION });
      onEvent({ type: 'error', code: 'conversation_busy', message: 'busy' });
      return Promise.resolve();
    });
    const api = turnsApi({ streamChat }) as unknown as ApiClient;
    const { hook, callbacks } = setup(api);
    await act(() => hook.result.current.send('¿Y RDS?', TARGET));
    await waitFor(() => {
      expect(callbacks.onBusy).toHaveBeenCalledWith('¿Y RDS?');
    });
    expect(hook.result.current.state.messages).toEqual([]);
    expect(hook.result.current.isStreaming).toBe(false);
  });

  it('says the turn was interrupted when Mango lost it after writing (round 40)', async () => {
    const streamChat = vi.fn(({ onEvent }: StreamChatRequest) => {
      onEvent({ type: 'conversation', conversation_id: CONVERSATION });
      onEvent({ type: 'delta', text: 'Gastaron' });
      onEvent({ type: 'error', code: 'upstream_error', message: 'the agent failed' });
      return Promise.resolve();
    });
    const api = turnsApi({ streamChat }) as unknown as ApiClient;
    const { hook } = setup(api);
    await act(() => hook.result.current.send('Hola', TARGET));
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)?.status).toBe('interrupted');
    });
    expect(last(hook.result.current.state.messages)?.content).toBe('Gastaron');
  });

  it('keeps an error that wrote nothing as an error', async () => {
    const streamChat = vi.fn(({ onEvent }: StreamChatRequest) => {
      onEvent({ type: 'conversation', conversation_id: CONVERSATION });
      onEvent({ type: 'error', code: 'upstream_error', message: 'the agent failed' });
      return Promise.resolve();
    });
    const { hook } = setup(turnsApi({ streamChat }) as unknown as ApiClient);
    await act(() => hook.result.current.send('Hola', TARGET));
    await waitFor(() => {
      expect(last(hook.result.current.state.messages)).toMatchObject({
        status: 'error',
        errorKey: 'errors.upstream_error',
      });
    });
  });

  it('«Cancelar» stops reading, tells the API and keeps what was written', async () => {
    const { streamChat } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ streamChat });
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
    const { streamChat, control } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ streamChat });
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
    const { streamChat, control } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ streamChat });
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
    const { streamChat } = pendingScript([{ type: 'delta', text: 'Gastaron' }]);
    const api = turnsApi({ streamChat });
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
