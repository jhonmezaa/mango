import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { ApiClient } from '../api/client';
import { ApiError, NotAuthenticatedError } from '../api/errors';
import {
  TURN_START,
  followTurn,
  type ConnectionState,
  type TurnEnd,
  type TurnProgress,
} from '../api/turnStream';
import type { ChatApproval } from '../api/schemas';
import { retryAtOf } from '../components/rateLimitWait';
import {
  CAP_STOP,
  chatReducer,
  errorKeyForCode,
  initialChatState,
  type DisplayMessage,
} from './chatState';
import { EMPTY_TURN, turnViewOf, type TurnView } from './turnView';

/** What a turn runs on: the agent of the conversation and one of its allowed models. */
export interface ChatTarget {
  agentId: string;
  model: string | null;
}

/** Design round 40: «Reconectado. La respuesta sigue donde iba.» stays this long. */
export const RESUMED_MS = 2500;

/** How a conversation is opened again (`reset`). */
export interface ResetOptions {
  /**
   * This tab's message was refused because another tab is answering in the conversation: the
   * question of that turn, when it is the last message, says «Desde otra pestaña».
   */
  otherTab?: boolean;
}

interface Options {
  api: ApiClient;
  onConversationStarted: (conversationId: string) => void;
  onTurnFinished: () => void;
  /**
   * The agent answered: not called for stopped or failed turns. `incomplete` when the answer
   * reached its token cap (design round 34, «Respuesta incompleta»).
   */
  onTurnCompleted?: (incomplete: boolean) => void;
  onUnauthenticated: () => void;
  /** The session ended while a turn was read: the answer goes on in Mango (design round 40). */
  onSessionEndedDuringTurn?: () => void;
  /**
   * The server refused the turn because another one of the conversation is being answered
   * (another tab): the message did not go out and goes back to the composer (design round 40).
   */
  onBusy?: (text: string) => void;
}

/** One turn being read: what «Volver a conectar» and «Cancelar» need. */
interface Reading {
  turnId: string;
  conversationId: string;
  assistantId: string;
  controller: AbortController;
  progress: TurnProgress;
  view: TurnView;
  /** The question of the turn, for «otra pestaña»; null for a turn read again on opening. */
  text: string | null;
  userId: string | null;
}

export function useChatStream({
  api,
  onConversationStarted,
  onTurnFinished,
  onTurnCompleted,
  onUnauthenticated,
  onSessionEndedDuringTurn,
  onBusy,
}: Options) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [isStreaming, setIsStreaming] = useState(false);
  const readingRef = useRef<Reading | null>(null);
  // A turn being created (before its id is known), so a second send waits.
  const creatingRef = useRef<{ controller: AbortController; assistantId: string } | null>(null);
  const resumedTimer = useRef<number | undefined>(undefined);
  // Bumped on each detach: a turn in flight found for a conversation left since is not followed.
  const openedRef = useRef(0);

  // Read through refs: the callbacks of the page change, the reading outlives a render.
  const callbacks = useRef({
    onConversationStarted,
    onTurnFinished,
    onTurnCompleted,
    onUnauthenticated,
    onSessionEndedDuringTurn,
    onBusy,
  });
  useEffect(() => {
    callbacks.current = {
      onConversationStarted,
      onTurnFinished,
      onTurnCompleted,
      onUnauthenticated,
      onSessionEndedDuringTurn,
      onBusy,
    };
  });

  /** Stops reading (the turn goes on in Mango); nothing is said to the API. */
  const detach = useCallback(() => {
    openedRef.current += 1;
    creatingRef.current?.controller.abort();
    creatingRef.current = null;
    readingRef.current?.controller.abort();
    readingRef.current = null;
    window.clearTimeout(resumedTimer.current);
    setIsStreaming(false);
  }, []);

  useEffect(() => detach, [detach]);

  const settle = useCallback((reading: Reading, end: TurnEnd) => {
    if (readingRef.current !== reading) return;
    const { assistantId } = reading;
    window.clearTimeout(resumedTimer.current);
    if (end.kind === 'aborted') return;
    if (end.kind === 'failed') {
      // Design round 40 «No se pudo reconectar»: the text stays and «Volver a conectar» reads
      // the turn again from where it stopped. «Cancelar» stays available meanwhile.
      reading.progress = end.progress;
      if (end.code === 'invalid_event') {
        dispatch({
          type: 'finish',
          assistantId,
          status: 'error',
          errorKey: 'errors.streamInterrupted',
        });
        readingRef.current = null;
        setIsStreaming(false);
        callbacks.current.onTurnFinished();
        return;
      }
      dispatch({ type: 'connection', assistantId, connection: { kind: 'failed' } });
      return;
    }
    readingRef.current = null;
    setIsStreaming(false);
    if (end.kind === 'unauthenticated') {
      // Design round 40: the partial text stays with «La respuesta sigue en Mango…».
      dispatch({ type: 'finish', assistantId, status: 'away' });
      const ended =
        callbacks.current.onSessionEndedDuringTurn ?? callbacks.current.onUnauthenticated;
      ended();
      return;
    }
    const view = reading.view;
    if (view.status === 'error' && view.error?.code === 'conversation_busy' && reading.text) {
      // Design round 40 «Otra pestaña»: the message did not go out; it goes back to the box.
      dispatch({
        type: 'withdraw',
        ids: [assistantId, ...(reading.userId ? [reading.userId] : [])],
      });
      callbacks.current.onBusy?.(reading.text);
      callbacks.current.onTurnFinished();
      return;
    }
    if (view.status === 'error' && view.error?.status === 401) {
      callbacks.current.onUnauthenticated();
    }
    if (view.status === 'in_progress') {
      // The stream ended without the end of the turn: never left as if it were running.
      dispatch({
        type: 'finish',
        assistantId,
        status: 'error',
        errorKey: 'errors.streamInterrupted',
      });
    }
    callbacks.current.onTurnFinished();
    if (view.status === 'finished') {
      callbacks.current.onTurnCompleted?.(view.result?.stop_reason === CAP_STOP);
    }
  }, []);

  /** Reads `reading` from where it stands until the turn ends or the reading stops. */
  const read = useCallback(
    (reading: Reading) => {
      const { assistantId } = reading;
      const onConnection = (connection: ConnectionState) => {
        if (readingRef.current !== reading) return;
        window.clearTimeout(resumedTimer.current);
        if (connection.kind === 'live') {
          dispatch({ type: 'connection', assistantId, connection: null });
        } else if (connection.kind === 'resumed') {
          dispatch({ type: 'connection', assistantId, connection: { kind: 'resumed' } });
          resumedTimer.current = window.setTimeout(() => {
            if (readingRef.current === reading) {
              dispatch({ type: 'connection', assistantId, connection: null });
            }
          }, RESUMED_MS);
        } else {
          dispatch({
            type: 'connection',
            assistantId,
            connection: { kind: 'reconnecting', attempt: connection.attempt },
          });
        }
      };
      void followTurn({
        open: (after, signal) => api.openTurnStream(reading.turnId, after, signal),
        signal: reading.controller.signal,
        from: reading.progress,
        onConnection,
        onProgress: (progress) => {
          if (readingRef.current !== reading) return;
          reading.progress = progress;
          const view = turnViewOf(progress.channels);
          const previous = reading.view;
          reading.view = view;
          dispatch({
            type: 'turn',
            assistantId,
            previous,
            view,
            receivedAt: performance.now(),
          });
        },
      }).then((end) => {
        settle(reading, end);
      });
    },
    [api, settle],
  );

  /**
   * Shows a conversation: `messages` once its history is loaded (none while it loads). Design
   * round 40 «Turno en curso al abrir»: a turn of it still queued or running (this tab's after a
   * reload, or another tab's) is read live from its first delta (R3b), after the history.
   */
  const reset = useCallback(
    (conversationId: string | null, messages?: DisplayMessage[], options: ResetOptions = {}) => {
      detach();
      const opened = openedRef.current;
      dispatch({ type: 'reset', conversationId, messages: messages ?? [] });
      if (!conversationId || messages === undefined) return;
      api.conversationTurn(conversationId).then(
        (turn) => {
          // Another conversation was opened, or this tab started a turn, meanwhile.
          if (!turn || openedRef.current !== opened) return;
          if (readingRef.current || creatingRef.current) return;
          const assistantId = crypto.randomUUID();
          dispatch({ type: 'resume', assistantId, otherTab: options.otherTab === true });
          const reading: Reading = {
            turnId: turn.turn_id,
            conversationId,
            assistantId,
            controller: new AbortController(),
            progress: TURN_START,
            view: EMPTY_TURN,
            text: null,
            userId: null,
          };
          readingRef.current = reading;
          setIsStreaming(true);
          read(reading);
        },
        // Not knowing is the same as no turn in flight: the history is already on screen.
        () => undefined,
      );
    },
    [api, detach, read],
  );

  const send = useCallback(
    async (text: string, target: ChatTarget) => {
      if (creatingRef.current || readingRef.current) return;
      const controller = new AbortController();
      const assistantId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const creating = { controller, assistantId };
      creatingRef.current = creating;
      setIsStreaming(true);
      dispatch({
        type: 'send',
        userId,
        assistantId,
        text,
        sentAt: new Date().toISOString(),
      });
      let created: { conversationId: string; turnId: string };
      try {
        created = await api.createTurn({
          conversationId: state.conversationId,
          // The agent is only sent to start a conversation; afterwards the API keeps it.
          agentId: state.conversationId === null ? target.agentId : null,
          model: target.model,
          message: text,
        });
      } catch (error) {
        if (creatingRef.current !== creating) return;
        creatingRef.current = null;
        setIsStreaming(false);
        if (error instanceof NotAuthenticatedError) {
          callbacks.current.onUnauthenticated();
          dispatch({ type: 'finish', assistantId, status: 'error', errorKey: 'errors.generic' });
        } else if (error instanceof ApiError) {
          if (error.status === 401) callbacks.current.onUnauthenticated();
          const retryAt = retryAtOf(error);
          dispatch({
            type: 'finish',
            assistantId,
            status: 'error',
            errorKey: errorKeyForCode(error.code, error.status),
            ...(retryAt === null ? {} : { retryAt }),
          });
        } else {
          dispatch({
            type: 'finish',
            assistantId,
            status: 'error',
            errorKey: error instanceof TypeError ? 'errors.network' : 'errors.generic',
          });
        }
        callbacks.current.onTurnFinished();
        return;
      }
      // «Cancelar» or another conversation while the turn was being created.
      if (creatingRef.current !== creating) {
        if (controller.signal.aborted) void api.cancelTurn(created.turnId).catch(() => undefined);
        return;
      }
      creatingRef.current = null;
      dispatch({ type: 'conversation', conversationId: created.conversationId });
      callbacks.current.onConversationStarted(created.conversationId);
      const reading: Reading = {
        turnId: created.turnId,
        conversationId: created.conversationId,
        assistantId,
        controller: new AbortController(),
        progress: TURN_START,
        view: EMPTY_TURN,
        text,
        userId,
      };
      readingRef.current = reading;
      read(reading);
    },
    [api, read, state.conversationId],
  );

  /**
   * «Cancelar» (D121 (7)): the turn ends interrupted in Mango; what was written stays, with
   * «Respuesta detenida…». Shown at once; the API is told without waiting for it.
   */
  const stop = useCallback(() => {
    const creating = creatingRef.current;
    const reading = readingRef.current;
    creating?.controller.abort();
    if (reading) {
      reading.controller.abort();
      readingRef.current = null;
      void api.cancelTurn(reading.turnId).catch(() => undefined);
    }
    window.clearTimeout(resumedTimer.current);
    const assistantId = reading?.assistantId ?? creating?.assistantId;
    if (assistantId) dispatch({ type: 'finish', assistantId, status: 'stopped' });
    creatingRef.current = null;
    setIsStreaming(false);
    if (creating || reading) callbacks.current.onTurnFinished();
  }, [api]);

  /** «Volver a conectar»: reads the turn again from where it stopped, without asking again. */
  const reconnect = useCallback(() => {
    const reading = readingRef.current;
    if (!reading) return;
    const next: Reading = { ...reading, controller: new AbortController() };
    readingRef.current = next;
    dispatch({
      type: 'connection',
      assistantId: reading.assistantId,
      connection: { kind: 'reconnecting', attempt: 1 },
    });
    read(next);
  }, [read]);

  const updateApproval = useCallback((approval: ChatApproval) => {
    dispatch({ type: 'approval', approval });
  }, []);

  return { state, isStreaming, send, stop, reset, reconnect, updateApproval };
}
