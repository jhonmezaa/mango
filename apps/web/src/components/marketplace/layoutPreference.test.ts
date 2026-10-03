import { afterEach, describe, expect, it } from 'vitest';

import { readLayout, writeLayout } from './layoutPreference';

describe('Marketplace layout preference', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('starts in cards and remembers the list', () => {
    expect(readLayout()).toBe('cards');
    writeLayout('list');
    expect(window.localStorage.getItem('mango-mk-layout')).toBe('list');
    expect(readLayout()).toBe('list');
    writeLayout('cards');
    expect(readLayout()).toBe('cards');
  });

  it('ignores anything else found in storage', () => {
    for (const value of ['table', '<img src=x onerror=alert(1)>', '', '{"layout":"list"}']) {
      window.localStorage.setItem('mango-mk-layout', value);
      expect(readLayout()).toBe('cards');
    }
  });
});
