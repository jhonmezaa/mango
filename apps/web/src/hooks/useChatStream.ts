import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import { ApiError, NotAuthenticatedError } from '../api/errors';
import type { ChatApproval } from '../api/schemas';
import {
  chatReducer,
  errorKeyForCode,
  initialChatState,
  type DisplayMessage,
  type ErrorKey,
} from './chatState';

// Read through a function: TypeScript would otherwise keep the narrowing from the assignment above,
// although other turns can change the ref while this one awaits.
const currentController = (ref: { current: AbortController | null }) => ref.current;

/** What a turn runs on: the agent of the conversation and one of its allowed models. */
export interface ChatTarget {
  agentId: string;
  model: string | null;
}

interface Options {
  api: ApiClient;
  onConversationStarted: (conversationId: string) => void;
  onTurnFinished: () => void;
  /** The agent answered in full (`done` event): not called for stopped or failed turns. */
  onTurnCompleted?: () => void;
  onUnauthenticated: () => void;
}

export function useChatStream({
  api,
  onConversationStarted,
  onTurnFinished,
  onTurnCompleted,
  onUnauthenticated,
}: Options) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const reset = useCallback(
    (conversationId: string | null, messages: DisplayMessage[] = []) => {
      stop();
      dispatch({ type: 'reset', conversationId, messages });
    },
    [stop],
  );

  const send = useCallback(
    async (text: string, target: ChatTarget) => {
      if (abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      const assistantId = crypto.randomUUID();
      dispatch({
        type: 'send',
        userId: crypto.randomUUID(),
        assistantId,
        text,
        sentAt: new Date().toISOString(),
      });

      // Mutated from callbacks, so kept in an object rather than narrowed locals.
      const turn: { settled: boolean; completed: boolean; errorKey: ErrorKey | null } = {
        settled: false,
        completed: false,
        errorKey: null,
      };
      try {
        await api.streamChat({
          conversationId: state.conversationId,
          // The agent is only sent to start a conversation; afterwards the API keeps it.
          agentId: state.conversationId === null ? target.agentId : null,
          model: target.model,
          message: text,
          signal: controller.signal,
          onEvent: (event) => {
            dispatch({ type: 'event', assistantId, event, receivedAt: performance.now() });
            if (event.type === 'conversation') onConversationStarted(event.conversation_id);
            if (event.type === 'done' || event.type === 'error') turn.settled = true;
            if (event.type === 'done') turn.completed = true;
          },
        });
      } catch (error) {
        if (error instanceof NotAuthenticatedError) {
          onUnauthenticated();
          turn.errorKey = 'errors.generic';
        } else if (error instanceof ApiError) {
          if (error.status === 401) onUnauthenticated();
          turn.errorKey = errorKeyForCode(error.code, error.status);
        } else if (!controller.signal.aborted) {
          turn.errorKey =
            error instanceof TypeError ? 'errors.network' : 'errors.streamInterrupted';
        }
      } finally {
        if (controller.signal.aborted) {
          dispatch({ type: 'finish', assistantId, status: 'stopped' });
        } else if (turn.errorKey) {
          dispatch({ type: 'finish', assistantId, status: 'error', errorKey: turn.errorKey });
        } else if (!turn.settled) {
          dispatch({
            type: 'finish',
            assistantId,
            status: 'error',
            errorKey: 'errors.streamInterrupted',
          });
        }
        // A newer turn may already own the ref (reset + send while this one was unwinding).
        const owner = currentController(abortRef);
        if (owner === controller || owner === null) {
          abortRef.current = null;
          setIsStreaming(false);
        }
        onTurnFinished();
        if (turn.completed && !turn.errorKey && !controller.signal.aborted) onTurnCompleted?.();
      }
    },
    [
      api,
      state.conversationId,
      onConversationStarted,
      onTurnFinished,
      onTurnCompleted,
      onUnauthenticated,
    ],
  );

  const updateApproval = useCallback((approval: ChatApproval) => {
    dispatch({ type: 'approval', approval });
  }, []);

  return { state, isStreaming, send, stop, reset, updateApproval };
}
