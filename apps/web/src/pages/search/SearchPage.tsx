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
  InfoIcon,
  RefreshIcon,
  SearchIcon,
  WarnIcon,
} from '../../components/icons';
import { agentIconStyle } from '../../components/marketplace/agentIcons';
import { RateWaitButton, RateWaitLine } from '../../components/RateWait';
import { retryAtOf } from '../../components/rateLimitWait';
import { Topbar } from '../../components/Topbar';
import { formatDateTime } from '../../lib/format';
import { chatFocusState } from '../chatFocus';
import {
  DEBOUNCE_MS,
  KIND_FILTERS,
  MAX_QUERY,
  NO_FILTERS,
  WHEN_FILTERS,
  anyFilter,
  clearRecentSearches,
  focusMessageOf,
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
/** Design round 35: «Buscando…» shows only when an answer takes longer than this to arrive. */
const SLOW_MS = 400;

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
  // Design round 35: after a 429, changing the query sends nothing until «Reintentar» at zero.
  const [rateUntil, setRateUntil] = useState<number | null>(null);
  // The query whose answer is taking longer than SLOW_MS (set by a timer).
  const [slowKey, setSlowKey] = useState('');
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
    if (!query || rateUntil !== null) return;
    const controller = new AbortController();
    let slow = 0;
    const timer = window.setTimeout(() => {
      // Counted from the request, not from the key: the pause before it is not waiting.
      slow = window.setTimeout(() => {
        setSlowKey(key);
      }, SLOW_MS);
      api.call('searchConversations', { body: query }, { signal: controller.signal }).then(
        (data) => {
          window.clearTimeout(slow);
          setLoad({ kind: 'ready', key, data });
        },
        (error: unknown) => {
          window.clearTimeout(slow);
          if (controller.signal.aborted) return;
          const retryAt = retryAtOf(error);
          if (retryAt !== null) setRateUntil(retryAt);
          setLoad({ kind: 'error', key, retryAt });
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(slow);
      window.clearTimeout(timer);
      controller.abort();
    };
    // `key` stands for `query`; `attempt` asks again after «Reintentar».
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key, attempt, rateUntil]);

  // While the next answer is on its way the previous one stays: no flicker per key.
  const data = load.kind === 'ready' ? load.data : null;
  const results = useMemo(() => (searching && data ? data.results : []), [searching, data]);
  const total = totalHits(results);
  const fresh = load.kind !== 'idle' && load.key === key;
  const failed = searching && load.kind === 'error' && fresh ? load : null;
  // Design round 35: the previous list stays while the next answer comes; past SLOW_MS a small
  // spinner and «Buscando…» show next to the count (alone on the first search).
  const pending = searching && !fresh && rateUntil === null;
  const slow = pending && slowKey === key;
  const retry = () => {
    setRateUntil(null);
    setAttempt((n) => n + 1);
  };

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
  const openConversation = (conversationId: string, messageId: string | null = null) => {
    void navigate(`/c/${encodeURIComponent(conversationId)}`, {
      state: chatFocusState(messageId),
    });
  };
  // Design round 35: a hit opens the conversation at its message; the card and Enter at the first
  // hit that is not the title. Title hits open it from its start.
  const go = (result: SearchResult, hit?: SearchHit) => {
    remember(q);
    openConversation(result.conversation_id, focusMessageOf(result, hit));
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
    if (!results.length || failed || rateUntil !== null) {
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

  // Design round 35 `.sr-cap`: the read stopped at its cap, and/or more conversations matched
  // than the answer carries (not with «Sin resultados»). Both lines, in that order.
  const showTruncated = data !== null && data.truncated && data.results.length > 0;
  const coverage = data && fresh && (data.capped || showTruncated) && (
    <div className="sr-cap">
      {data.capped && (
        <span>
          <InfoIcon size={12} />
          <span>{t('search.capped', { count: data.conversations_read })}</span>
        </span>
      )}
      {showTruncated && (
        <span>
          <InfoIcon size={12} />
          <span>{t('search.truncated', { count: data.results.length })}</span>
        </span>
      )}
    </div>
  );
  const busy = slow && (
    <span className="sr-busy" aria-hidden="true">
      <span className="spinner" />
      {t('search.searching')}
    </span>
  );
  // One hidden status for assistive technology (design round 35).
  const live = !searching
    ? ''
    : rateUntil !== null
      ? t('search.rateTitle')
      : failed
        ? t('search.error')
        : pending
          ? slow
            ? t('search.searching')
            : ''
          : data
            ? results.length
              ? t('search.liveCount', {
                  hits: total,
                  conversations: results.length,
                  hitsWord: t('search.hitsWord', { count: total }),
                  conversationsWord: t('search.conversationsWord', { count: results.length }),
                })
              : t('search.liveNone')
            : '';

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
  } else if (rateUntil !== null) {
    body = (
      <div className="mk-empty sr-err" role="alert">
        <span className="sr-err-ic">
          <ClockIcon size={16} />
        </span>
        <div className="sr-empty-t">{t('search.rateTitle')}</div>
        <div className="sr-empty-s">
          {t('search.rateBody')} <RateWaitLine until={rateUntil} />
        </div>
        <RateWaitButton until={rateUntil} onRetry={retry} />
      </div>
    );
  } else if (failed) {
    body = (
      <div className="mk-empty sr-err" role="alert">
        <span className="sr-err-ic">
          <WarnIcon size={16} />
        </span>
        <div className="sr-empty-t">{t('search.error')}</div>
        <button type="button" className="btn btn-sm" onClick={retry}>
          <RefreshIcon size={11} />
          {t('common.retry')}
        </button>
      </div>
    );
  } else if (!data) {
    // First search, nothing to keep on screen: the «Buscando…» line alone, past SLOW_MS.
    body = <div className="sr-count">{busy}</div>;
  } else if (results.length === 0) {
    body = (
      <>
        <div className="mk-empty" aria-busy={!fresh}>
          <div className="sr-empty-t">{t('search.noResults', { query: q.trim() })}</div>
          <div className="sr-empty-s">
            {filtered ? t('search.noResultsFiltered') : t('search.noResultsHint')}
          </div>
          {filtered && (
            <button type="button" className="btn btn-sm" onClick={clearFilters}>
              {t('search.removeFilters')}
            </button>
          )}
          {busy}
        </div>
        {coverage}
      </>
    );
  } else {
    body = (
      <>
        <div className="sr-count">
          <span className="sr-count-main">
            <span className="sr-count-n">
              <b>{total}</b> {t('search.hitsWord', { count: total })} {t('search.in')}{' '}
              <b>{results.length}</b> {t('search.conversationsWord', { count: results.length })}
            </span>
            {busy}
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
                      go(result, hit);
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
              aria-expanded={searching && results.length > 0}
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

          <div className="sr-only" role="status" aria-live="polite">
            {live}
          </div>
          {body}
        </div>
      </div>
    </>
  );
}
