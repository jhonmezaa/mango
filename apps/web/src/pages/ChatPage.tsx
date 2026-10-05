import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import { chatPath, defaultAgentId, isChatable, parseAgentId, type Agent } from '../agents/agents';
import type { ApiClient } from '../api/client';
import { conversationIdSchema } from '../api/schemas';
import { useAuth } from '../auth/useAuth';
import { useSession } from '../auth/useSession';
import { useToasts } from '../components/admin/useToasts';
import { AgentHero } from '../components/chat/AgentHero';
import { BlockedComposer, ChatBlocked, type ChatBlockedKind } from '../components/chat/ChatBlocked';
import { ChatHeader } from '../components/chat/ChatHeader';
import { ChatInput } from '../components/chat/ChatInput';
import { ChatMessage } from '../components/chat/ChatMessage';
import { ThreadList } from '../components/chat/ThreadList';
import { CloseIcon, RefreshIcon, WarnIcon } from '../components/icons';
import { fromApiMessage, type DisplayMessage, type ErrorKey } from '../hooks/chatState';
import { useChatStream } from '../hooks/useChatStream';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { NotFoundPage } from './NotFoundPage';

// Only agents with write tools ever show it: it stays out of the main chunk until then.
const ChatApprovalCard = lazy(() =>
  import('../components/chat/ChatApprovalCard').then((module) => ({
    default: module.ChatApprovalCard,
  })),
);

// Failures where sending the same question again can succeed. Budget, permission and validation
// errors would fail the same way, so they get no retry button.
const RETRYABLE: ReadonlySet<ErrorKey> = new Set([
  'errors.generic',
  'errors.network',
  'errors.streamInterrupted',
  'errors.upstream_error',
  'errors.agent_unavailable',
  'errors.conversation_busy',
]);

function retryPrompt(messages: DisplayMessage[]): string | null {
  const last = messages.at(-1);
  const previous = messages.at(-2);
  if (last?.role !== 'assistant' || last.status !== 'error' || previous?.role !== 'user') {
    return null;
  }
  return RETRYABLE.has(last.errorKey ?? 'errors.generic') ? previous.content : null;
}

type LoadResult = { id: string; ok: boolean } | null;

// Shapes of the conversation skeleton (design chat.jsx `ChatSkeleton`): two questions, each
// followed by the lines of its answer.
const SKELETON_BLOCKS = [
  { bubble: 'w-[46%]', lines: ['w-[92%]', 'w-[86%]', 'w-[64%]'] },
  { bubble: 'w-[38%]', lines: ['w-[88%]', 'w-[72%]'] },
] as const;

function ConversationSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      className="chat-column chat-skeleton"
      role="status"
      aria-busy="true"
      aria-label={t('chat.conversationLoading')}
    >
      {SKELETON_BLOCKS.map((block) => (
        <Fragment key={block.bubble}>
          <div className={`skeleton chat-skeleton-bubble ${block.bubble}`} />
          <div className="chat-skeleton-lines">
            {block.lines.map((width) => (
              <div key={width} className={`skeleton chat-skeleton-line ${width}`} />
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

const CONVERSATION_SKELETON = <ConversationSkeleton />;

function fetchConversation(
  api: ApiClient,
  id: string,
  onLoaded: (messages: DisplayMessage[], conversationId: string, agentId: string) => void,
  onResult: (result: LoadResult) => void,
): () => void {
  let cancelled = false;
  api.getConversation(id).then(
    (conversation) => {
      if (cancelled) return;
      const approvals = new Map(
        (conversation.approvals ?? []).map((item) => [item.approval_id, item]),
      );
      onLoaded(
        conversation.messages.map((message) => fromApiMessage(message, approvals)),
        conversation.conversation_id,
        conversation.agent_id,
      );
      onResult({ id, ok: true });
    },
    () => {
      if (!cancelled) onResult({ id, ok: false });
    },
  );
  return () => {
    cancelled = true;
  };
}

/** Agent of a conversation, as far as this page knows it. */
interface ConversationAgent {
  conversationId: string;
  agentId: string;
}

const NO_AGENTS: ReadonlyMap<string, Agent> = new Map();
/** Design chat.jsx: farther than this from the end, the person does not see a new answer. */
const SEEN_END_PX = 80;

/**
 * Chat with an agent (design chat.jsx). The agent is the one of the conversation; a new
 * conversation takes it from `?agent=<id>` (Marketplace «Abrir chat», pinned agents, the agent
 * picker) or, without it, from the user's most recent conversation.
 *
 * Nothing here decides access: the agents are the ones GET /api/agents returns for this user and
 * the API authorizes every turn. Agent id and model are only choices sent to it.
 */
export function ChatPage() {
  const { t } = useTranslation();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const {
    api,
    me,
    conversations,
    conversationsError,
    reloadConversations,
    agents,
    agentsError,
    reloadAgents,
  } = useSession();
  const { expireSession } = useAuth();
  // Design chat.jsx: a toast when the answer is complete and when a new conversation starts.
  const { notify, stack: toasts } = useToasts();
  // Outcome of the last conversation fetch, keyed by ID so stale results are ignored.
  const [loadResult, setLoadResult] = useState<LoadResult>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The end of an answer in words for screen readers, when no toast says it.
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    // Warm the lazily loaded markdown chunk so the first answer renders formatted.
    void import('../components/ChatMarkdown');
  }, []);

  const routeId = params.conversationId ?? null;
  const validRouteId = routeId === null || conversationIdSchema.safeParse(routeId).success;
  // Untrusted input (the URL): only a well-formed agent id is used.
  const requestedAgentId = routeId === null ? parseAgentId(searchParams.get('agent')) : null;

  // The agent of the conversation on screen: read with the conversation, or the one this page
  // started it with. Until then the history list already says which one it is.
  const [knownAgent, setKnownAgent] = useState<ConversationAgent | null>(null);
  const agentsById = useMemo(
    () => (agents ? new Map(agents.map((item) => [item.id, item])) : NO_AGENTS),
    [agents],
  );
  const lastAgentIds = useMemo(
    () => (conversations ?? []).map((item) => item.agent_id),
    [conversations],
  );
  const conversationAgentId =
    routeId === null
      ? null
      : knownAgent?.conversationId === routeId
        ? knownAgent.agentId
        : (conversations?.find((item) => item.conversation_id === routeId)?.agent_id ?? null);
  const agentId =
    routeId === null
      ? (requestedAgentId ??
        (agents && (conversations || conversationsError)
          ? defaultAgentId(agents, lastAgentIds)
          : null))
      : conversationAgentId;
  const listedAgent = agentId ? (agentsById.get(agentId) ?? null) : null;

  // An agent the list does not carry (it failed to load, or it was published after it loaded)
  // is asked for by id; the API answers only if the user may use it.
  const [fetchedAgent, setFetchedAgent] = useState<{ id: string; agent: Agent | null } | null>(
    null,
  );
  const missingAgentId = agentId && !listedAgent && (agents || agentsError) ? agentId : null;
  useEffect(() => {
    if (!missingAgentId) return;
    let cancelled = false;
    api.call('getAgent', { path: { agent_id: missingAgentId } }).then(
      (found) => {
        if (!cancelled) setFetchedAgent({ id: missingAgentId, agent: found });
      },
      () => {
        if (!cancelled) setFetchedAgent({ id: missingAgentId, agent: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, missingAgentId]);
  const agent =
    listedAgent ?? (fetchedAgent && fetchedAgent.id === agentId ? fetchedAgent.agent : null);
  // Still finding out which agent this is, as opposed to knowing there is none to use.
  const agentPending =
    agentId === null
      ? routeId !== null ||
        (!agents && !agentsError) ||
        (agents !== null && !conversations && !conversationsError && !requestedAgentId)
      : !agent && (missingAgentId === null || fetchedAgent?.id !== agentId);

  // Model of the next turn: the user's choice for this agent while the version still allows
  // it, else the agent's default (design `ModelSwitcher`). Derived, never stored per agent.
  const [modelChoice, setModelChoice] = useState<{ agentId: string; model: string } | null>(null);
  const allowedModels = agent
    ? agent.allowed_models.length > 0
      ? agent.allowed_models
      : [agent.model]
    : [];
  const model = agent
    ? modelChoice?.agentId === agent.id && allowedModels.includes(modelChoice.model)
      ? modelChoice.model
      : agent.model
    : null;
  const chooseModel = useCallback(
    (next: string) => {
      if (agentId) setModelChoice({ agentId, model: next });
    },
    [agentId],
  );

  const onConversationStarted = useCallback(
    (conversationId: string) => {
      if (agentId) setKnownAgent({ conversationId, agentId });
      // Reflect the new conversation in the URL without reloading it from the API.
      void navigate(`/c/${encodeURIComponent(conversationId)}`, { replace: true });
      reloadConversations();
    },
    [agentId, navigate, reloadConversations],
  );

  const answeredBy = agent?.name ?? t('chat.agentUnknown');
  // Design chat.jsx `finish`: the toast only when the person does not see the end of the
  // conversation (the tab is in the background, or they scrolled up); otherwise the answer itself
  // says it. Screen readers hear it either way: from the toast, or from the live region.
  const onTurnCompleted = useCallback(() => {
    const body = t('chat.toast.doneBody', { name: answeredBy });
    const title = t('chat.toast.doneTitle');
    const el = scrollRef.current;
    const awayFromEnd =
      el !== null && el.scrollHeight - el.scrollTop - el.clientHeight > SEEN_END_PX;
    if (document.hidden || awayFromEnd) notify(body, 'success', title);
    else setAnnouncement(`${title}. ${body}`);
  }, [answeredBy, notify, t]);

  const { state, isStreaming, send, stop, reset, updateApproval } = useChatStream({
    api,
    onConversationStarted,
    onTurnFinished: reloadConversations,
    onTurnCompleted,
    onUnauthenticated: expireSession,
  });

  // Reacts to navigation only. Reading the in-memory conversation through an effect event means
  // that a conversation created by the stream (state updated first, URL replaced afterwards) is
  // never reloaded or reset.
  const syncWithRoute = useEffectEvent((id: string | null) => {
    if (id === state.conversationId) return undefined;
    if (id === null) {
      reset(null);
      return undefined;
    }
    reset(id);
    return fetchConversation(
      api,
      id,
      (messages, conversationId, conversationAgent) => {
        setKnownAgent({ conversationId, agentId: conversationAgent });
        reset(conversationId, messages);
      },
      setLoadResult,
    );
  });

  useEffect(() => {
    if (!validRouteId) return;
    return syncWithRoute(routeId);
  }, [routeId, validRouteId]);

  const loadError = routeId !== null && loadResult?.id === routeId && !loadResult.ok;
  const loading =
    routeId !== null && state.messages.length === 0 && !loadError && loadResult?.id !== routeId;

  // The retry fetch is not tied to an effect, so it checks that the route has not changed before
  // replacing the conversation on screen.
  const currentRouteRef = useRef(routeId);
  useEffect(() => {
    currentRouteRef.current = routeId;
  }, [routeId]);

  const retryLoad = () => {
    if (routeId === null) return;
    setLoadResult(null);
    fetchConversation(
      api,
      routeId,
      (messages, conversationId, conversationAgent) => {
        if (currentRouteRef.current !== routeId) return;
        setKnownAgent({ conversationId, agentId: conversationAgent });
        reset(conversationId, messages);
      },
      setLoadResult,
    );
  };

  // Follow the last message while it grows: text, tool calls, and its final status (error notice,
  // usage line).
  const lastMessage = state.messages.at(-1);
  const lastContentLength = lastMessage?.content.length ?? 0;
  const lastToolCount = lastMessage?.tools.length ?? 0;
  const lastStatus = lastMessage?.status;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [state.messages.length, lastContentLength, lastToolCount, lastStatus]);

  // Below 1100px the conversation list is not a column (design v0.11); it opens as a drawer so the
  // history stays reachable.
  const narrow = useMediaQuery('(max-width: 1100px)');
  const [historyOpen, setHistoryOpen] = useState(false);
  // Widening past the breakpoint closes the drawer, so it does not reopen when narrowing again.
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow);
    setHistoryOpen(false);
  }
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
  }, []);
  const drawerOpen = narrow && historyOpen;
  const drawerRef = useFocusTrap<HTMLElement>(drawerOpen, closeHistory);

  // Design `newChat`: a new conversation with the same agent (when it still takes turns).
  const canChat = agent !== null && isChatable(agent);
  // The list of agents failed and this one could not be read either: nothing is known about it.
  const agentsFailed = agentsError && !agent && !agentPending;
  // Design chat.jsx `blocked`: no agent to talk to, and why.
  const blocked: ChatBlockedKind | null =
    agentPending || agentsFailed || canChat
      ? null
      : agent
        ? 'retired'
        : agentId
          ? 'unavailable'
          : 'none';
  const newChat = useCallback(() => {
    setHistoryOpen(false);
    void navigate(chatPath(canChat ? agentId : null));
    notify(t('chat.toast.newChat'), 'info');
  }, [agentId, canChat, navigate, notify, t]);

  const sendText = useCallback(
    (text: string) => {
      if (!agentId || !canChat) return;
      // Emptied first, so the same sentence is announced again after the next answer.
      setAnnouncement('');
      void send(text, { agentId, model });
    },
    [agentId, canChat, model, send],
  );

  // "Observar" (design: chat.jsx): live tool calls start expanded. Session-only UI state.
  const [observe, setObserve] = useState(false);
  const toggleObserve = useCallback(() => {
    setObserve((value) => !value);
  }, []);

  if (!validRouteId) return <NotFoundPage />;

  const isEmpty = state.messages.length === 0 && !loading && !loadError;
  const agentName = agent?.name ?? t('chat.agentUnknown');
  const retryText = isStreaming ? null : retryPrompt(state.messages);

  return (
    <div className="chat-grid">
      {!narrow && (
        <ThreadList
          conversations={conversations}
          agents={agentsById}
          error={conversationsError}
          activeId={routeId}
          onNew={newChat}
          onRetry={reloadConversations}
        />
      )}
      {drawerOpen && (
        <div
          className="overlay overlay-drawer"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeHistory();
          }}
        >
          {/* Design chat.jsx: the history opens in a 340px `Drawer` titled "Historial". */}
          <aside
            ref={drawerRef}
            className="drawer chat-threads-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-history-title"
          >
            <div className="drawer-head">
              <h2 id="chat-history-title" className="drawer-title">
                {t('chat.history')}
              </h2>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={t('common.close')}
                onClick={closeHistory}
              >
                <CloseIcon size={13} />
              </button>
            </div>
            <ThreadList
              conversations={conversations}
              agents={agentsById}
              error={conversationsError}
              activeId={routeId}
              onNew={newChat}
              onRetry={reloadConversations}
              onPick={closeHistory}
            />
          </aside>
        </div>
      )}
      <div className="chat-main">
        <ChatHeader
          agent={agent}
          model={model}
          onModelChange={chooseModel}
          headingLevel={isEmpty && agent ? 'p' : 'h1'}
          observe={observe}
          onToggleObserve={toggleObserve}
          onNewChat={newChat}
          onOpenConversations={
            narrow
              ? () => {
                  setHistoryOpen(true);
                }
              : undefined
          }
        />
        <div ref={scrollRef} className="chat-scroll">
          {isEmpty && agent && canChat && (
            <AgentHero agent={agent} disabled={isStreaming} onPrompt={sendText} />
          )}
          {isEmpty && agentPending && CONVERSATION_SKELETON}
          {isEmpty && blocked && <ChatBlocked kind={blocked} />}
          {isEmpty && agentsFailed && (
            <div className="chat-load-error" role="alert">
              <span className="chat-load-error-icon">
                <WarnIcon size={18} />
              </span>
              <h2 className="chat-load-error-title">{t('chat.noAgent.loadError')}</h2>
              <p className="chat-load-error-body">{t('chat.noAgent.loadErrorBody')}</p>
              <div className="chat-load-error-actions">
                <button type="button" className="btn btn-sm" onClick={reloadAgents}>
                  <RefreshIcon size={11} />
                  {t('errors.retry')}
                </button>
              </div>
            </div>
          )}
          {loading && CONVERSATION_SKELETON}
          {loadError && (
            <div className="chat-load-error" role="alert">
              <span className="chat-load-error-icon">
                <WarnIcon size={18} />
              </span>
              <h2 className="chat-load-error-title">{t('chat.loadError')}</h2>
              <div className="chat-load-error-actions">
                <button type="button" className="btn btn-sm btn-primary" onClick={retryLoad}>
                  <RefreshIcon size={11} />
                  {t('errors.retry')}
                </button>
                <button type="button" className="btn btn-sm" onClick={newChat}>
                  {t('nav.newChat')}
                </button>
              </div>
            </div>
          )}
          {state.messages.length > 0 && (
            <div className="chat-column">
              {/* Design chat.jsx «tools faltantes»: the API lists the tools of the version
                  whose MCP is disabled now (`unavailable_tools`). */}
              {agent && canChat && agent.unavailable_tools.length > 0 && (
                <div className="mc-alert amber chat-notice" role="status">
                  <WarnIcon size={14} />
                  <div>{t('chat.toolsMissing', { name: agent.name })}</div>
                </div>
              )}
              {state.messages.map((message, index) => {
                const previous = state.messages[index - 1];
                // Agent answers can be regenerated by sending their question again as a new turn.
                const question =
                  !isStreaming && message.role === 'assistant' && previous?.role === 'user'
                    ? previous.content
                    : null;
                return (
                  <Fragment key={message.id}>
                    <ChatMessage
                      message={message}
                      observe={observe}
                      isAdmin={me.is_admin}
                      onSend={sendText}
                      resendText={question}
                      retryText={
                        retryText !== null && index === state.messages.length - 1 ? retryText : null
                      }
                    />
                    {/* Design chat.jsx: the write actions of the answer wait here for a person
                        (D27). What a card shows is what the API stored, never the model's text. */}
                    {message.approvals && message.approvals.length > 0 ? (
                      <Suspense fallback={null}>
                        {message.approvals.map((approval) => (
                          <ChatApprovalCard
                            key={approval.approval_id}
                            api={api}
                            me={me}
                            approval={approval}
                            onUpdated={updateApproval}
                            notify={notify}
                          />
                        ))}
                      </Suspense>
                    ) : null}
                  </Fragment>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
        {/* Design chat.jsx `load-error`: nothing is known about the agents, so no composer. */}
        {agentsFailed ? null : blocked ? (
          <BlockedComposer kind={blocked} />
        ) : (
          <ChatInput
            agentName={agentName}
            disabled={!canChat}
            isStreaming={isStreaming}
            onSend={sendText}
            onStop={stop}
          />
        )}
      </div>
      {toasts}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
