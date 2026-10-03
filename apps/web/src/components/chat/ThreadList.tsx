import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Agent } from '../../agents/agents';
import type { ConversationSummary } from '../../api/schemas';
import { formatDateTime } from '../../lib/format';
import { PlusIcon, RefreshIcon, SearchIcon } from '../icons';
import { ChatAgentAvatar } from './ChatAgentAvatar';
import { formatThreadTime, groupThreads } from './threadGroups';

interface Props {
  conversations: ConversationSummary[] | null;
  /** Agents the user may use, by id: each conversation shows the one it belongs to. */
  agents: ReadonlyMap<string, Agent>;
  error: boolean;
  activeId: string | null;
  onNew: () => void;
  /** Loads the history again after a failure. */
  onRetry: () => void;
  /** Drawer mode (≤1100px): closes the "Historial" drawer after picking a conversation. */
  onPick?: (() => void) | undefined;
}

// Title widths of the loading skeleton (design: chat.jsx ThreadList `state="loading"`, 5 rows).
const SKELETON_WIDTHS = ['w-[80%]', 'w-[72%]', 'w-[64%]', 'w-[56%]', 'w-[48%]'] as const;

/**
 * Conversation history (design: chat.jsx ThreadList), grouped by day. Filtering is client-side
 * over the loaded history. The API returns no last-message preview, unread count or pinned flag,
 * so the secondary line is the agent name. Titles and agent names come from the API and are
 * rendered as text.
 */
export function ThreadList({
  conversations,
  agents,
  error,
  activeId,
  onNew,
  onRetry,
  onPick,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase('es');

  const groups = useMemo(() => {
    if (!conversations) return null;
    const visible = needle
      ? conversations.filter((item) => item.title.toLocaleLowerCase('es').includes(needle))
      : conversations;
    return groupThreads(visible);
  }, [conversations, needle]);

  const yesterday = t('chat.groups.yesterday');

  return (
    <section className="thread-list" aria-labelledby="thread-list-title">
      <div className="thread-list-head">
        <h2 id="thread-list-title" className="thread-list-title">
          {t('chat.conversations')}
        </h2>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t('nav.newChat')}
          title={t('nav.newChat')}
          onClick={onNew}
        >
          <PlusIcon size={13} />
        </button>
      </div>
      <div className="thread-list-search">
        <div className="search-wrap">
          <SearchIcon size={12} />
          <input
            type="search"
            name="conversation-search"
            className="input"
            aria-label={t('chat.searchConversations')}
            placeholder={t('chat.searchPlaceholder')}
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
      </div>

      <div className="thread-list-body">
        {error && (
          <div className="thread-list-error" role="alert">
            {t('nav.historyError')}
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              <RefreshIcon size={11} />
              {t('common.retry')}
            </button>
          </div>
        )}
        {!conversations && !error && (
          <div
            className="grid gap-3.5 p-3"
            role="status"
            aria-busy="true"
            aria-label={t('chat.historyLoading')}
          >
            {SKELETON_WIDTHS.map((width) => (
              <div key={width} className="flex items-center gap-2">
                <div className="skeleton h-[26px] w-[26px] shrink-0 rounded-md" />
                <div className="grid flex-1 gap-1.5">
                  <div className={`skeleton h-2.5 rounded-[3px] ${width}`} />
                  <div className="skeleton h-2 w-2/5 rounded-[3px]" />
                </div>
              </div>
            ))}
          </div>
        )}
        {conversations?.length === 0 && (
          <p className="thread-list-empty">{t('nav.emptyHistory')}</p>
        )}
        {groups?.length === 0 && conversations && conversations.length > 0 && (
          <p className="thread-list-empty">{t('chat.noMatches', { query: query.trim() })}</p>
        )}
        {groups?.map((group) => (
          <section key={group.key} aria-labelledby={`thread-group-${group.key}`}>
            <h3 id={`thread-group-${group.key}`} className="thread-group-label">
              {t(`chat.groups.${group.key}`).toLocaleLowerCase('es')}
            </h3>
            <ul className="thread-group-list">
              {group.items.map((conversation) => {
                const agent = agents.get(conversation.agent_id) ?? null;
                return (
                  <li key={conversation.conversation_id}>
                    <Link
                      to={`/c/${encodeURIComponent(conversation.conversation_id)}`}
                      className="thread-row"
                      aria-current={conversation.conversation_id === activeId ? 'page' : undefined}
                      onClick={onPick}
                    >
                      <ChatAgentAvatar agent={agent} size="sm" />
                      <span className="thread-row-body">
                        <span className="thread-row-top">
                          <span className="thread-row-title" title={conversation.title}>
                            {conversation.title}
                          </span>
                          <time
                            className="thread-row-time"
                            dateTime={conversation.updated_at}
                            title={formatDateTime(conversation.updated_at)}
                          >
                            {formatThreadTime(conversation.updated_at, yesterday)}
                          </time>
                        </span>
                        <span className="thread-row-sub">
                          {agent?.name ?? t('chat.agentUnknown')}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
