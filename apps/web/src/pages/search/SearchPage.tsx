import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type { Agent } from '../../agents/agents';
import { useSession } from '../../auth/useSession';
import { formatThreadTime } from '../../components/chat/threadGroups';
import {
  ArrowRightIcon,
  ClockIcon,
  CloseIcon,
  RefreshIcon,
  SearchIcon,
} from '../../components/icons';
import { agentIconStyle } from '../../components/marketplace/agentIcons';
import { RateWaitButton, RateWaitLine } from '../../components/RateWait';
import { retryAtOf } from '../../components/rateLimitWait';
import { Topbar } from '../../components/Topbar';
import { formatDateTime } from '../../lib/format';
import {
  DEBOUNCE_MS,
  KIND_FILTERS,
  MAX_QUERY,
  NO_FILTERS,
  WHEN_FILTERS,
  anyFilter,
  clearRecentSearches,
  isSearching,
  listedHits,
  queryOf,
  recentSearches,
  rememberSearch,
  totalHits,
  type Filters,
  type KindFilter,
  type SearchAnswer,
  type SearchHit,
  type SearchResult,
  type SortOrder,
  type WhenFilter,
} from './model';

type Load =
  | { kind: 'idle' }
  | { kind: 'ready'; key: string; data: SearchAnswer }
  | { kind: 'error'; key: string; retryAt: number | null };

/** Recent conversations of the idle state (design: six). */
const RECENT_CONVERSATIONS = 6;

function AgentIcon({ agent }: { agent: Agent | null }) {
  const { Icon, colorClass } = agentIconStyle(agent?.icon ?? 'Bot', agent?.color ?? 0);
  return (
    <span className={`tk-agent-ic sr-agent-ic ${colorClass}`} aria-hidden="true">
      <Icon size={12} />
    </span>
  );
}

/** A snippet: plain-text parts from the API, the terms in `<mark>`; never HTML (D103). */
function Snippet({ hit }: { hit: SearchHit }) {
  return (
    <>
      {hit.pre && '…'}
      {hit.parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="sr-mark">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
      {hit.post && '…'}
    </>
  );
}

/**
 * Buscar conversaciones (design search.jsx `GlobalSearch`, D103): the person's own conversations,
 * searched by mango-api. Titles, snippets and agent names come from the API and are rendered as
 * text. Recent searches live in memory while the tab is open (not in `localStorage`, unlike the
 * design). Opening a result opens its conversation, as the design's `openChat`.
 */
export function SearchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { api, me, agents, conversations } = useSession();
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(() => recentSearches(me.user_id));
  const [load, setLoad] = useState<Load>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const agentsById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const searching = isSearching(q);
  const query = useMemo(() => (searching ? queryOf(q, filters) : null), [searching, q, filters]);
  const key = query ? JSON.stringify(query) : '';

  useEffect(() => {
    // Without a query the idle state shows; a previous answer is simply not shown.
    if (!query) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.call('searchConversations', { body: query }, { signal: controller.signal }).then(
        (data) => {
          setLoad({ kind: 'ready', key, data });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setLoad({ kind: 'error', key, retryAt: retryAtOf(error) });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `key` stands for `query`; `attempt` asks again after «Reintentar».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, attempt]);

  // While the next answer is on its way the previous one stays: no flicker per key.
  const data = load.kind === 'ready' ? load.data : null;
  const results = useMemo(() => (searching && data ? data.results : []), [searching, data]);
  const total = totalHits(results);
  const fresh = load.kind !== 'idle' && load.key === key;
  const failed = searching && load.kind === 'error' && fresh ? load : null;

  // A new query or filter starts at the first result (design), set while rendering.
  const [activeKey, setActiveKey] = useState(key);
  if (activeKey !== key) {
    setActiveKey(key);
    setActive(0);
  }

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (event.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    listRef.current?.querySelector(`[data-sr="${String(active)}"]`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [active]);

  const remember = useCallback(
    (term: string) => {
      setRecent(rememberSearch(me.user_id, term));
    },
    [me.user_id],
  );
  const clearRecent = () => {
    clearRecentSearches(me.user_id);
    setRecent([]);
  };
  const openConversation = (conversationId: string) => {
    void navigate(`/c/${encodeURIComponent(conversationId)}`);
  };
  const go = (result: SearchResult) => {
    remember(q);
    openConversation(result.conversation_id);
  };
  const setFilter = <K extends keyof Filters>(name: K, value: Filters[K]) => {
    setFilters((current) => ({ ...current, [name]: value }));
  };
  const clearFilters = () => {
    setFilters((current) => ({ ...NO_FILTERS, sort: current.sort }));
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setQ('');
      return;
    }
    if (!results.length) {
      if (event.key === 'Enter') remember(q);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(results.length - 1, index + 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const result = results[active];
      if (result) go(result);
    }
  };
  const filtered = anyFilter(filters);
  const yesterday = t('chat.groups.yesterday');
  const agentName = (agentId: string) => agentsById.get(agentId)?.name ?? t('chat.agentUnknown');

  const coverage = data && fresh && (data.capped || data.truncated) && (
    <p className="sr-note">
      {data.capped
        ? t('search.capped', { count: data.conversations_read })
        : t('search.truncated', { count: data.results.length })}
    </p>
  );

  let body;
  if (!searching) {
    body = (
      <div className="sr-idle">
        {recent.length > 0 && (
          <section>
            <div className="sr-sec-h">
              <span>{t('search.recent')}</span>
              <button type="button" className="sr-link" onClick={clearRecent}>
                {t('search.clearRecent')}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {recent.map((term) => (
                <button
                  key={term}
                  type="button"
                  className="tk-chip"
                  onClick={() => {
                    setQ(term);
                  }}
                >
                  <ClockIcon size={11} />
                  {term}
                </button>
              ))}
            </div>
          </section>
        )}
        {conversations && conversations.length > 0 && (
          <section>
            <div className="sr-sec-h">
              <span>{t('search.recentConversations')}</span>
            </div>
            <div className="card sr-card">
              {conversations.slice(0, RECENT_CONVERSATIONS).map((conversation) => (
                <button
                  key={conversation.conversation_id}
                  type="button"
                  className="sr-thread"
                  onClick={() => {
                    openConversation(conversation.conversation_id);
                  }}
                >
                  <AgentIcon agent={agentsById.get(conversation.agent_id) ?? null} />
                  <span className="sr-thread-main">
                    <span className="sr-t">{conversation.title}</span>
                    <span className="sr-s">{agentName(conversation.agent_id)}</span>
                  </span>
                  <time
                    className="tk-meta"
                    dateTime={conversation.updated_at}
                    title={formatDateTime(conversation.updated_at)}
                  >
                    {formatThreadTime(conversation.updated_at, yesterday)}
                  </time>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  } else if (failed) {
    body = (
      <div className="mk-empty" role="alert">
        <div className="sr-empty-t">{t('search.error')}</div>
        {failed.retryAt !== null ? (
          <>
            <div className="sr-empty-s">
              <RateWaitLine until={failed.retryAt} />
            </div>
            <RateWaitButton
              until={failed.retryAt}
              onRetry={() => {
                setAttempt((n) => n + 1);
              }}
            />
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            <RefreshIcon size={11} />
            {t('common.retry')}
          </button>
        )}
      </div>
    );
  } else if (!data) {
    body = (
      // The design draws no loading state: only assistive technology hears it.
      <p className="sr-only" role="status" aria-busy="true">
        {t('search.searching')}
      </p>
    );
  } else if (results.length === 0) {
    body = (
      <div className="mk-empty" role="status" aria-busy={!fresh}>
        <div className="sr-empty-t">{t('search.noResults', { query: q.trim() })}</div>
        <div className="sr-empty-s">
          {filtered ? t('search.noResultsFiltered') : t('search.noResultsHint')}
        </div>
        {coverage}
        {filtered && (
          <button type="button" className="btn btn-sm" onClick={clearFilters}>
            {t('search.removeFilters')}
          </button>
        )}
      </div>
    );
  } else {
    body = (
      <>
        <div className="sr-count">
          <span>
            <b>{total}</b> {t('search.hitsWord', { count: total })} {t('search.in')}{' '}
            <b>{results.length}</b> {t('search.conversationsWord', { count: results.length })}
          </span>
          <select
            className="input mk-sel"
            aria-label={t('search.sortLabel')}
            value={filters.sort}
            onChange={(event) => {
              setFilter('sort', event.target.value as SortOrder);
            }}
          >
            <option value="relevance">{t('search.sort.relevance')}</option>
            <option value="recent">{t('search.sort.recent')}</option>
          </select>
        </div>
        {coverage}
        <div
          id="sr-results"
          ref={listRef}
          role="listbox"
          aria-label={t('search.title')}
          aria-busy={!fresh}
          className="sr-results"
        >
          {results.map((result, index) => {
            const open = expanded[result.conversation_id] ?? false;
            const agent = agentsById.get(result.agent_id) ?? null;
            return (
              <div
                key={result.conversation_id}
                id={`sr-${String(index)}`}
                data-sr={index}
                role="option"
                aria-selected={index === active}
                className={`card sr-card${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => {
                  setActive(index);
                }}
              >
                <button
                  type="button"
                  className="sr-thread head"
                  onClick={() => {
                    go(result);
                  }}
                >
                  <AgentIcon agent={agent} />
                  <span className="sr-thread-main">
                    <span className="sr-t">{result.title}</span>
                    <span className="sr-s">
                      {agentName(result.agent_id)} ·{' '}
                      {formatThreadTime(result.updated_at, yesterday)}
                    </span>
                  </span>
                  <span className="sr-open">
                    {t('search.open')} <ArrowRightIcon size={11} />
                  </span>
                </button>
                {listedHits(result, open).map((hit) => (
                  <button
                    key={`${hit.kind}:${hit.message_id ?? 'title'}`}
                    type="button"
                    className="sr-hit"
                    onClick={() => {
                      go(result);
                    }}
                  >
                    <span className={`sr-kind k-${hit.kind}`}>{t(`search.kind.${hit.kind}`)}</span>
                    <span className={`sr-snip${hit.kind === 'tool' ? ' mono' : ''}`}>
                      <Snippet hit={hit} />
                    </span>
                  </button>
                ))}
                {result.hits.length > 3 && (
                  <button
                    type="button"
                    className="sr-more"
                    onClick={() => {
                      setExpanded((current) => ({ ...current, [result.conversation_id]: !open }));
                    }}
                  >
                    {open ? t('search.less') : t('search.more', { count: result.hits.length - 3 })}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="sr-hint">
          <kbd>↑</kbd>
          <kbd>↓</kbd> {t('search.hintMove')} · <kbd>Enter</kbd> {t('search.hintOpen')} ·{' '}
          <kbd>Esc</kbd> {t('search.hintClear')}
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar crumbs={[t('search.title')]} />
      <div className="content">
        <div className="sr-wrap">
          <h1 className="sr-h1">{t('search.title')}</h1>
          <div className="search-wrap sr-input">
            <SearchIcon size={15} />
            <input
              ref={inputRef}
              className="input"
              // Design: the page is its input.
              autoFocus
              aria-label={t('search.inputLabel')}
              placeholder={t('search.placeholder')}
              value={q}
              maxLength={MAX_QUERY}
              onChange={(event) => {
                setQ(event.target.value);
              }}
              onKeyDown={onKey}
              onBlur={() => {
                if (searching && results.length) remember(q);
              }}
              role="combobox"
              aria-expanded={searching}
              aria-controls="sr-results"
              aria-activedescendant={
                searching && results.length ? `sr-${String(active)}` : undefined
              }
            />
            {q ? (
              <button
                type="button"
                className="sr-clear"
                aria-label={t('search.clear')}
                onClick={() => {
                  setQ('');
                  inputRef.current?.focus();
                }}
              >
                <CloseIcon size={13} />
              </button>
            ) : (
              <kbd className="sr-kbd">/</kbd>
            )}
          </div>

          <div className="sr-filters">
            <select
              className="input mk-sel"
              aria-label={t('search.agentLabel')}
              value={filters.agent}
              onChange={(event) => {
                setFilter('agent', event.target.value);
              }}
            >
              <option value="all">{t('search.allAgents')}</option>
              {(agents ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <select
              className="input mk-sel"
              aria-label={t('search.whenLabel')}
              value={filters.when}
              onChange={(event) => {
                setFilter('when', event.target.value as WhenFilter);
              }}
            >
              {WHEN_FILTERS.map((when) => (
                <option key={when} value={when}>
                  {t(`search.when.${when}`)}
                </option>
              ))}
            </select>
            <div className="tk-quick" role="group" aria-label={t('search.kindLabel')}>
              {KIND_FILTERS.map((kind: KindFilter) => (
                <button
                  key={kind}
                  type="button"
                  className={filters.kind === kind ? 'is-on' : ''}
                  aria-pressed={filters.kind === kind}
                  onClick={() => {
                    setFilter('kind', kind);
                  }}
                >
                  {t(`search.kindFilter.${kind}`)}
                </button>
              ))}
            </div>
            {filtered && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>
                {t('search.clearFilters')}
              </button>
            )}
          </div>

          {body}
        </div>
      </div>
    </>
  );
}
