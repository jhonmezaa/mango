import { afterEach, describe, expect, it } from 'vitest';

import {
  NO_FILTERS,
  clearRecentSearches,
  isSearching,
  listedHits,
  queryOf,
  recentSearches,
  rememberSearch,
  totalHits,
  type SearchHit,
  type SearchResult,
} from './model';

const hit = (kind: SearchHit['kind'], id: string): SearchHit => ({
  kind,
  message_id: kind === 'title' ? null : id,
  pre: false,
  post: false,
  parts: [{ text: id, hit: true }],
});
const result = (hits: SearchHit[]): SearchResult => ({
  conversation_id: 'a'.repeat(32),
  title: 't',
  agent_id: 'finops',
  updated_at: '2026-11-03T10:00:00+00:00',
  hits,
});

afterEach(() => {
  clearRecentSearches('u1');
  clearRecentSearches('u2');
});

describe('search model', () => {
  it('starts at two characters', () => {
    expect(isSearching(' e ')).toBe(false);
    expect(isSearching('ec')).toBe(true);
  });

  it('sends only the filters that are set, the query trimmed and bounded', () => {
    const now = new Date('2026-11-03T10:00:00Z');
    expect(queryOf(`  ${'x'.repeat(300)} `, NO_FILTERS, now).q).toHaveLength(200);
    expect(queryOf('ec2', NO_FILTERS, now)).not.toHaveProperty('agent');
    expect(queryOf('ec2', { ...NO_FILTERS, agent: 'security' }, now).agent).toBe('security');
  });

  it('lists the messages before the title, three until expanded (design)', () => {
    const r = result([hit('title', 't'), hit('user', 'a'), hit('agent', 'b'), hit('tool', 'c')]);
    expect(listedHits(r, false).map((h) => h.message_id)).toEqual(['a', 'b']);
    expect(listedHits(r, true).map((h) => h.message_id)).toEqual(['a', 'b', 'c']);
    expect(listedHits(result([hit('title', 't')]), false)).toHaveLength(1);
  });

  it('counts the hits in messages, at least one per conversation', () => {
    expect(
      totalHits([result([hit('title', 't')]), result([hit('user', 'a'), hit('tool', 'b')])]),
    ).toBe(3);
  });

  it('keeps six recent searches per person, newest first, without repeats', () => {
    for (const term of ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'DOS', 'a']) {
      rememberSearch('u1', term);
    }
    expect(recentSearches('u1')).toEqual(['DOS', 'siete', 'seis', 'cinco', 'cuatro', 'tres']);
    expect(recentSearches('u2')).toEqual([]);
  });
});
