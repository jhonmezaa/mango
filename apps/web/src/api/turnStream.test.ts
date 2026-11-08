import { describe, expect, it, vi } from 'vitest';

import {
  framesOf,
  type TurnEnd as RecordEnd,
  type TurnEventRecord,
} from '../../mock/turnTranslator';
import { ApiError, NotAuthenticatedError } from './errors';
import {
  MAX_ATTEMPTS,
  baseDelay,
  followTurn,
  retryDelay,
  type ConnectionState,
  type FollowOptions,
} from './turnStream';
import { turnViewOf } from '../hooks/turnView';

const TURN = 't'.repeat(32);
const CONVERSATION = 'c'.repeat(32);

/** The events a turn stores (D57), as the worker writes them. */
const EVENTS: TurnEventRecord[] = [
  { kind: 'conversation', data: { conversation_id: CONVERSATION } },
  { kind: 'status', data: { phase: 'thinking' } },
  { kind: 'tool', data: { name: 'get_cost_and_usage', status: 'started' } },
  { kind: 'status', data: { phase: 'tool', tool: 'get_cost_and_usage' } },
  { kind: 'tool', data: { name: 'get_cost_and_usage', status: 'completed' } },
  { kind: 'status', data: { phase: 'writing' } },
  { kind: 'delta', data: { text: 'Gastaron ' } },
  { kind: 'delta', data: { text: '**USD 10**' } },
  { kind: 'delta', data: { text: ' en EC2.' } },
  {
    kind: 'done',
    data: {
      message_id: 'm1',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
      cost_usd: '0.01',
    },
  },
];

function response(body: string, chunk = 7): Response {
  const encoder = new TextEncoder();
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        // Small chunks that split frames, lines and CRLF anywhere.
        if (offset >= body.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(body.slice(offset, offset + chunk)));
        offset += chunk;
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

/** Cuts a stream body after its `n`-th delta frame (the connection drops there). */
function cutAfter(body: string, n: number): string {
  const frames = body.split('\n\n');
  let seen = 0;
  const out: string[] = [];
  for (const frame of frames) {
    if (frame.includes('event: delta\n') && frame.startsWith('id:')) {
      if (seen === n) break;
      seen += 1;
    }
    if (frame.includes('message_stream_complete')) break;
    out.push(frame);
  }
  return `${out.join('\n\n')}\n\n`;
}

const noSleep = (): Promise<void> => Promise.resolve();

function follow(open: FollowOptions['open'], extra: Partial<FollowOptions> = {}) {
  const states: ConnectionState[] = [];
  const result = followTurn({
    open,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onConnection: (state) => states.push(state),
    sleep: noSleep,
    random: () => 0,
    ...extra,
  });
  return { result, states };
}

const whole = (end: RecordEnd | null = null) => framesOf(TURN, CONVERSATION, EVENTS, end);
const TOTAL = (whole().match(/^id: /gm) ?? []).length;

describe('followTurn', () => {
  it('reads a turn to its end and builds the answer', async () => {
    const { result } = follow(() => Promise.resolve(response(whole())));
    const end = await result;
    expect(end.kind).toBe('complete');
    const view = turnViewOf(end.progress.channels);
    expect(view.status).toBe('finished');
    expect(view.text).toBe('Gastaron **USD 10** en EC2.');
    expect(view.tools).toEqual([{ name: 'get_cost_and_usage', status: 'completed' }]);
    expect(view.result).toMatchObject({ message_id: 'm1', stop_reason: 'end_turn' });
    expect(end.progress.lastId).toBe(TOTAL);
  });

  it.each(Array.from({ length: TOTAL }, (_, n) => n))(
    'resumes a connection cut after delta %i without repeating or losing anything',
    async (n) => {
      const afters: number[] = [];
      const open = vi.fn((after: number) => {
        afters.push(after);
        const body = framesOf(TURN, CONVERSATION, EVENTS, null, after);
        return Promise.resolve(response(afters.length === 1 ? cutAfter(body, n) : body));
      });
      const { result, states } = follow(open);
      const end = await result;
      expect(end.kind).toBe('complete');
      expect(afters).toEqual([0, n]);
      const view = turnViewOf(end.progress.channels);
      expect(view.text).toBe('Gastaron **USD 10** en EC2.');
      expect(view.tools).toEqual([{ name: 'get_cost_and_usage', status: 'completed' }]);
      expect(states).toEqual([{ kind: 'reconnecting', attempt: 1 }, { kind: 'resumed' }]);
    },
  );

  it.each([408, 409, 425, 429, 502, 504])('retries a %i', async (status) => {
    let calls = 0;
    const { result } = follow((after) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new ApiError(status, `http_${String(status)}`, 'x'));
      return Promise.resolve(response(framesOf(TURN, CONVERSATION, EVENTS, null, after)));
    });
    expect((await result).kind).toBe('complete');
    expect(calls).toBe(2);
  });

  it('retries a network failure', async () => {
    let calls = 0;
    const { result } = follow((after) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(response(framesOf(TURN, CONVERSATION, EVENTS, null, after)));
    });
    expect((await result).kind).toBe('complete');
  });

  it.each([403, 404, 500, 503])('stops on a %i without retrying', async (status) => {
    const open = vi.fn(() => Promise.reject(new ApiError(status, 'x', 'x')));
    const end = await follow(open).result;
    expect(end).toMatchObject({ kind: 'failed', status });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('ends the session on a 401 or without a session', async () => {
    const first = await follow(() => Promise.reject(new ApiError(401, 'x', 'x'))).result;
    expect(first.kind).toBe('unauthenticated');
    const second = await follow(() => Promise.reject(new NotAuthenticatedError('none'))).result;
    expect(second.kind).toBe('unauthenticated');
  });

  it('gives up after 12 attempts and resumes from where it stopped («Volver a conectar»)', async () => {
    const half = Math.floor(TOTAL / 2);
    let calls = 0;
    const open = (after: number) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          response(cutAfter(framesOf(TURN, CONVERSATION, EVENTS, null, after), half)),
        );
      }
      return Promise.reject(new ApiError(502, 'http_502', 'Bad Gateway'));
    };
    const { result, states } = follow(open);
    const end = await result;
    expect(end).toMatchObject({ kind: 'failed', code: 'reconnect_failed' });
    expect(calls).toBe(1 + MAX_ATTEMPTS);
    expect(states.map((state) => (state.kind === 'reconnecting' ? state.attempt : 0))).toEqual(
      Array.from({ length: MAX_ATTEMPTS }, (_, i) => i + 1),
    );
    expect(end.progress.lastId).toBe(half);
    const afters: number[] = [];
    const again = await follow(
      (after) => {
        afters.push(after);
        return Promise.resolve(response(framesOf(TURN, CONVERSATION, EVENTS, null, after)));
      },
      { from: end.progress },
    ).result;
    expect(afters).toEqual([half]);
    expect(turnViewOf(again.progress.channels).text).toBe('Gastaron **USD 10** en EC2.');
  });

  it('refuses a stream that breaks the applier, without retrying it', async () => {
    const bad =
      'event: delta_encoding\ndata: "v1"\n\nid: 1\nevent: delta\ndata: {"c":0,"p":"/__proto__/x","o":"add","v":1}\n\n';
    const open = vi.fn(() => Promise.resolve(response(bad)));
    const end = await follow(open).result;
    expect(end).toMatchObject({ kind: 'failed', code: 'invalid_event' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('stops when the reading is aborted', async () => {
    const controller = new AbortController();
    const result = followTurn({
      open: () => {
        controller.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      },
      signal: controller.signal,
      onProgress: () => undefined,
      onConnection: () => undefined,
      sleep: noSleep,
    });
    expect((await result).kind).toBe('aborted');
  });

  it('waits 300 ms × 1.5 per attempt, up to 5 s, with 50 % jitter', () => {
    expect(baseDelay(1)).toBe(300);
    expect(baseDelay(2)).toBe(450);
    expect(baseDelay(3)).toBe(675);
    expect(baseDelay(12)).toBe(5000);
    expect(retryDelay(2, () => 0)).toBe(450);
    expect(retryDelay(2, () => 0.999_999)).toBe(225);
    const total = Array.from({ length: MAX_ATTEMPTS }, (_, i) => baseDelay(i + 1)).reduce(
      (sum, ms) => sum + ms,
      0,
    );
    // Design round 40: about 35 s before «No se pudo reconectar».
    expect(total).toBeGreaterThan(30_000);
    expect(total).toBeLessThan(45_000);
  });
});
