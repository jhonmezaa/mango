import { Translator, type TurnEventRecord } from '../../mock/turnTranslator';
import { applyDelta, NO_CHANNELS, type Channels, type Json } from '../api/deltas';
import type { ChatApproval } from '../api/schemas';
import { chatReducer, type ChatState } from '../hooks/chatState';
import { EMPTY_TURN, turnViewOf, type TurnView } from '../hooks/turnView';

/**
 * An event of D57 as a turn's record stores it (`apps/api/src/mango_api/turns.py`): what the
 * tests write to say what a turn did. The API translates them into `v1` deltas (D120); the
 * tests read them the same way, through `mock/turnTranslator.ts`.
 */
export type ScriptEvent =
  | { type: 'conversation'; conversation_id: string }
  | { type: 'tool'; name: string; status: 'started' | 'completed' | 'error' }
  | { type: 'status'; phase: string; tool?: string }
  | { type: 'delta'; text: string }
  | { type: 'approval'; approval: ChatApproval }
  | {
      type: 'knowledge';
      knowledge_bases: string[];
      count: number;
      sources: { knowledge_base: string; document: string; page?: number }[];
    }
  | { type: 'remote_connection_required'; registration_id: string }
  | {
      type: 'done';
      message_id: string;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
      cost_usd: string;
      remote_sources?: string[];
    }
  | { type: 'error'; code: string; message: string };

/** The record of one event, as the worker writes it. */
export function recordOf(event: ScriptEvent): TurnEventRecord {
  if (event.type === 'approval') return { kind: event.type, data: { ...event.approval } };
  const { type, ...data } = event;
  return { kind: type, data };
}

function viewOf(conversationId: string, events: readonly ScriptEvent[]): TurnView {
  const translator = new Translator('t1', conversationId);
  let channels: Channels = NO_CHANNELS;
  for (const event of events) {
    if (event.type === 'conversation') continue;
    for (const delta of translator.feed(recordOf(event))) {
      channels = applyDelta(channels, { ...delta, v: delta.v as Json });
    }
  }
  return channels === NO_CHANNELS ? EMPTY_TURN : turnViewOf(channels);
}

/** The events each state of a test has fed each answer, so a test can branch from any. */
const fed = new WeakMap<ChatState, ReadonlyMap<string, readonly ScriptEvent[]>>();

/**
 * One event of a turn on the reducer, as the hook folds what each delta changes: the
 * translator of the API, the applier of the web and the view of the chat, then `turn`.
 * Pure for the test: feeding the same state twice gives two branches of the same turn.
 */
export function feed(
  state: ChatState,
  assistantId: string,
  event: ScriptEvent,
  receivedAt?: number,
): ChatState {
  const history = fed.get(state) ?? new Map<string, readonly ScriptEvent[]>();
  if (event.type === 'conversation') {
    const next = chatReducer(state, {
      type: 'conversation',
      conversationId: event.conversation_id,
    });
    fed.set(next, history);
    return next;
  }
  const before = history.get(assistantId) ?? [];
  const after = [...before, event];
  const conversationId = state.conversationId ?? 'c1';
  const next = chatReducer(state, {
    type: 'turn',
    assistantId,
    previous: viewOf(conversationId, before),
    view: viewOf(conversationId, after),
    ...(receivedAt === undefined ? {} : { receivedAt }),
  });
  fed.set(next, new Map([...history, [assistantId, after]]));
  return next;
}
