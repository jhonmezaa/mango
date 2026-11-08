import { CANCELLED, framesOf, type TurnEnd, type TurnEventRecord } from '../../mock/turnTranslator';
import type { ApiClient } from '../api/client';
import { recordOf, type ScriptEvent } from './turnEvents';

/** A turn of a chat test: the events of D57 as the worker stores them. */
export interface TestTurn {
  turnId: string;
  conversationId: string;
  events: TurnEventRecord[];
  end: TurnEnd | null;
  readers: Set<() => void>;
}

/** What a test's turn is asked: the body of `POST /api/chat/turns`, and where to say it. */
export interface TurnScriptRequest {
  conversationId: string | null;
  agentId: string | null;
  model: string | null;
  message: string;
  signal: AbortSignal;
  onEvent: (event: ScriptEvent) => void;
}

/** A test's turn: it says what happened with the events of D57, as the worker records them. */
export type TurnScript = (request: TurnScriptRequest) => Promise<void>;

const ended = (turn: TestTurn) =>
  turn.end !== null || turn.events.some((e) => e.kind === 'done' || e.kind === 'error');

/** One connection: the turn in `v1` from `after + 1`, and what arrives until it ends. */
function streamOf(turn: TestTurn, after: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  let stop = (): void => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = () => {
        const frames = framesOf(turn.turnId, turn.conversationId, turn.events, turn.end, after);
        if (frames.length > sent) {
          controller.enqueue(encoder.encode(frames.slice(sent)));
          sent = frames.length;
        }
        if (frames.includes('[DONE]')) {
          stop();
          controller.close();
        }
      };
      stop = () => {
        turn.readers.delete(push);
      };
      signal.addEventListener('abort', () => {
        stop();
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          // Already closed.
        }
      });
      turn.readers.add(push);
      push();
    },
    cancel() {
      stop();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * The chat API of the tests in `v1` (D120, D121), driven by a script: it calls `onEvent` with
 * the events of D57 and the turn is read in deltas from them, as the API translates its record. A script that rejects at once is a refused
 * `POST /api/chat/turns`; one that ends without `done` or `error` ends the turn in error.
 */
export function turnsApi<T extends { turnScript: TurnScript }>(
  base: T,
): T &
  Pick<ApiClient, 'createTurn' | 'openTurnStream' | 'cancelTurn' | 'conversationTurn'> & {
    turns: TestTurn[];
  } {
  const turns: TestTurn[] = [];
  const controllers = new Map<string, AbortController>();
  return {
    ...base,
    turns,
    async createTurn(request) {
      const controller = new AbortController();
      const turn: TestTurn = {
        turnId: `turn${String(turns.length + 1)}`,
        conversationId: request.conversationId ?? 'c-new',
        events: [],
        end: null,
        readers: new Set(),
      };
      const notify = () => {
        for (const reader of [...turn.readers]) reader();
      };
      let refused: { error: unknown } | null = null;
      let created = false;
      const running = base
        .turnScript({
          conversationId: request.conversationId,
          agentId: request.agentId ?? null,
          model: request.model ?? null,
          message: request.message,
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'conversation') {
              turn.conversationId = event.conversation_id;
              return;
            }
            if (ended(turn)) return;
            turn.events.push(recordOf(event));
            notify();
          },
        })
        .then(
          () => {
            if (!ended(turn)) {
              turn.end = {
                state: 'failed',
                error: { status: 502, code: 'stream_interrupted', message: 'x' },
              };
            }
            notify();
          },
          (error: unknown) => {
            refused = { error };
            if (created && !ended(turn))
              turn.events.push({ kind: 'error', data: { ...CANCELLED } });
            notify();
          },
        );
      // A script that rejects at once is the POST that failed.
      void running;
      for (let tick = 0; tick < 5; tick++) await Promise.resolve();
      const failed = refused as { error: unknown } | null;
      if (failed) throw failed.error;
      created = true;
      turns.push(turn);
      controllers.set(turn.turnId, controller);
      return { conversationId: turn.conversationId, turnId: turn.turnId };
    },
    openTurnStream(turnId, after, signal) {
      const turn = turns.find((item) => item.turnId === turnId);
      if (!turn) return Promise.reject(new Error('unknown turn'));
      return Promise.resolve(streamOf(turn, after, signal));
    },
    // The turn of the conversation still running, as `GET /api/conversations/{id}/turn` (R3b).
    conversationTurn(conversationId) {
      const turn = turns.find((item) => item.conversationId === conversationId && !ended(item));
      return Promise.resolve(turn ? { turn_id: turn.turnId, state: 'running' as const } : null);
    },
    cancelTurn(turnId) {
      const turn = turns.find((item) => item.turnId === turnId);
      if (turn && !ended(turn)) turn.events.push({ kind: 'error', data: { ...CANCELLED } });
      controllers.get(turnId)?.abort();
      return Promise.resolve({ turn_id: turnId, state: 'interrupted', cancelled: true });
    },
  };
}
