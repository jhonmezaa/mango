import type { OperationInput, OperationOutput } from '../../api/operations';

// Buscar conversaciones (design search.jsx `GlobalSearch`, D103). The server searches the
// person's own conversations and answers snippets as plain-text parts; this module holds what
// the page decides by itself: when there is a query, the request, the counts and the recent
// searches.

export type SearchAnswer = OperationOutput<'searchConversations'>;
export type SearchResult = SearchAnswer['results'][number];
export type SearchHit = SearchResult['hits'][number];
export type SearchQuery = OperationInput<'searchConversations'>['body'];

export type KindFilter = 'all' | 'title' | 'user' | 'agent' | 'tool';
export type WhenFilter = 'all' | 'today' | 'yesterday';
export type SortOrder = 'relevance' | 'recent';

export const KIND_FILTERS: readonly KindFilter[] = ['all', 'title', 'user', 'agent', 'tool'];
export const WHEN_FILTERS: readonly WhenFilter[] = ['all', 'today', 'yesterday'];

/** As the API (`MAX_QUERY`): longer input is not sent. */
export const MAX_QUERY = 200;
/** Design: a search starts at two characters. */
export const MIN_QUERY = 2;
/** Pause in typing before the page asks (one request per pause, not per key). */
export const DEBOUNCE_MS = 300;
/** Hits shown per conversation before «Ver N más» (design). */
export const SHOWN_HITS = 3;
/** Recent searches kept (design). */
export const RECENT_MAX = 6;

export interface Filters {
  agent: string;
  kind: KindFilter;
  when: WhenFilter;
  sort: SortOrder;
}

export const NO_FILTERS: Filters = { agent: 'all', kind: 'all', when: 'all', sort: 'relevance' };

export function isSearching(q: string): boolean {
  return q.trim().length >= MIN_QUERY;
}

export function anyFilter(filters: Filters): boolean {
  return filters.agent !== 'all' || filters.kind !== 'all' || filters.when !== 'all';
}

/** The person's clock minus UTC in minutes, for «Hoy» and «Desde ayer» (Bogotá: -300). */
export function utcOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset();
}

export function queryOf(q: string, filters: Filters, now: Date = new Date()): SearchQuery {
  return {
    q: q.trim().slice(0, MAX_QUERY),
    ...(filters.agent === 'all' ? {} : { agent: filters.agent }),
    kind: filters.kind,
    when: filters.when,
    sort: filters.sort,
    utc_offset_minutes: utcOffsetMinutes(now),
  };
}

/** The hits a card lists: the messages when there are any, the title otherwise (design). */
export function listedHits(result: SearchResult, expanded: boolean): SearchHit[] {
  const shown = expanded ? result.hits : result.hits.slice(0, SHOWN_HITS);
  return result.hits.some((hit) => hit.kind !== 'title')
    ? shown.filter((hit) => hit.kind !== 'title')
    : shown;
}

/** «N coincidencias»: the hits in messages, at least one per conversation (design). */
export function totalHits(results: readonly SearchResult[]): number {
  return results.reduce(
    (sum, result) => sum + Math.max(1, result.hits.filter((hit) => hit.kind !== 'title').length),
    0,
  );
}

// --- Recent searches -------------------------------------------------------------------------
// In memory only (D103, chosen 2026-11-03): they live while the tab is open and never reach
// `localStorage` or `sessionStorage`, unlike the design. Kept per person, so a sign-in of another
// account in the same tab does not see them.

const recentByUser = new Map<string, string[]>();

export function recentSearches(userId: string): string[] {
  return recentByUser.get(userId) ?? [];
}

export function rememberSearch(userId: string, term: string): string[] {
  const value = term.trim().slice(0, MAX_QUERY);
  const current = recentSearches(userId);
  if (value.length < MIN_QUERY) return current;
  const lower = value.toLocaleLowerCase('es');
  const next = [value, ...current.filter((item) => item.toLocaleLowerCase('es') !== lower)].slice(
    0,
    RECENT_MAX,
  );
  recentByUser.set(userId, next);
  return next;
}

export function clearRecentSearches(userId: string): void {
  recentByUser.delete(userId);
}

// --- Open at the hit (design round 35) ---------------------------------------------------------

/**
 * The message a result opens at: the hit's own, or for the card and Enter the first hit that is
 * not the title. Title hits open the conversation from its start (null).
 */
export function focusMessageOf(result: SearchResult, hit?: SearchHit): string | null {
  const target = hit ?? result.hits.find((item) => item.kind !== 'title');
  return target?.message_id ?? null;
}
