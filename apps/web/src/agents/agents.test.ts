import { afterEach, describe, expect, it } from 'vitest';

import { agentFixture } from '../test/fixtures';
import { chatPath, defaultAgentId, isChatable, parseAgentId, serverCount } from './agents';
import { readPinnedAgents, togglePinnedAgent } from './pinned';

const A = agentFixture({ id: 'abcdefghijklmnop', name: 'A' });
const B = agentFixture({ id: 'finops', name: 'B' });
const OLD = agentFixture({ id: 'qrstuvwxyz234567', name: 'Old', status: 'retired' });

describe('agents', () => {
  it('accepts only ids in the format of the API', () => {
    for (const id of ['finops', 'abcdefghijklmnop', 'a2', 'k3fq7zr2m5xw6n4a']) {
      expect(parseAgentId(id)).toBe(id);
    }
    for (const value of [
      '',
      'a',
      'Fin Ops',
      '../me',
      'x'.repeat(17),
      'ABC',
      null,
      42,
      ['finops'],
    ]) {
      expect(parseAgentId(value)).toBeNull();
    }
  });

  it('builds the path of a new conversation', () => {
    expect(chatPath('finops')).toBe('/?agent=finops');
    expect(chatPath(null)).toBe('/');
  });

  it('counts connectors, not tools', () => {
    expect(serverCount([])).toBe(0);
    expect(serverCount(['cost-explorer.a', 'cost-explorer.b', 'crm.search'])).toBe(2);
  });

  it('only chats with published agents', () => {
    expect(isChatable(A)).toBe(true);
    expect(isChatable(OLD)).toBe(false);
  });

  it('defaults to the agent of the most recent conversation that can still be used', () => {
    expect(defaultAgentId([A, B, OLD], ['finops', 'abcdefghijklmnop'])).toBe('finops');
    // Retired or no longer listed: the next one.
    expect(defaultAgentId([A, B, OLD], ['qrstuvwxyz234567', 'zzzzzzzzzzzzzzzz', A.id])).toBe(A.id);
    expect(defaultAgentId([A, B, OLD], [])).toBe(A.id);
    expect(defaultAgentId([OLD], ['qrstuvwxyz234567'])).toBeNull();
    expect(defaultAgentId([], [])).toBeNull();
  });
});

describe('pinned agents (a preference of this browser)', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('pins the release agent until the user chooses', () => {
    expect(readPinnedAgents()).toEqual(['finops']);
    window.localStorage.setItem('mango-pinned-agents', '[]');
    expect(readPinnedAgents()).toEqual([]);
  });

  it('treats storage as untrusted: only well-formed, distinct ids, at most twenty', () => {
    window.localStorage.setItem(
      'mango-pinned-agents',
      JSON.stringify(['finops', '<img src=x>', 7, null, 'finops', { id: 'x' }, 'abcdefghijklmnop']),
    );
    expect(readPinnedAgents()).toEqual(['finops', 'abcdefghijklmnop']);
    for (const raw of ['not json', '{"a":1}', '"finops"', 'null']) {
      window.localStorage.setItem('mango-pinned-agents', raw);
      expect(readPinnedAgents()).toEqual(['finops']);
    }
    const many = Array.from({ length: 40 }, (_, index) => `agent${String(index)}`);
    window.localStorage.setItem('mango-pinned-agents', JSON.stringify(many));
    expect(readPinnedAgents()).toHaveLength(20);
  });

  it('toggles and stores the list', () => {
    const pinned = togglePinnedAgent(['finops'], 'abcdefghijklmnop');
    expect(pinned).toEqual(['finops', 'abcdefghijklmnop']);
    expect(window.localStorage.getItem('mango-pinned-agents')).toBe(
      '["finops","abcdefghijklmnop"]',
    );
    expect(togglePinnedAgent(pinned, 'finops')).toEqual(['abcdefghijklmnop']);
    expect(readPinnedAgents()).toEqual(['abcdefghijklmnop']);
    // Something that is not an agent id is never stored.
    expect(togglePinnedAgent([], '../x')).toEqual([]);
  });

  it('keeps working when storage is not available', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    try {
      expect(readPinnedAgents()).toEqual(['finops']);
      expect(togglePinnedAgent(['finops'], 'abcdefghijklmnop')).toHaveLength(2);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
