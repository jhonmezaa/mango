import { describe, expect, it } from 'vitest';

import type { Units } from '../api/adminSchemas';
import {
  diffUnits,
  isExpired,
  mapToUnits,
  ousOf,
  ouTree,
  proposerOf,
  touchesArea,
  unitsToMap,
} from './businessUnits';

const before = { finanzas: ['ou-1'], retail: ['ou-2', 'ou-3'], legado: ['ou-9'] };

describe('diffUnits', () => {
  it('reports added, removed and changed areas with their OUs', () => {
    const after = { finanzas: ['ou-1'], retail: ['ou-3', 'ou-4'], nueva: ['ou-5'] };
    expect(diffUnits(before, after)).toEqual([
      { area: 'legado', kind: 'removed', added: [], removed: ['ou-9'] },
      { area: 'nueva', kind: 'added', added: ['ou-5'], removed: [] },
      { area: 'retail', kind: 'changed', added: ['ou-4'], removed: ['ou-2'] },
    ]);
  });

  it('ignores order and reports nothing when the mapping is equal', () => {
    expect(diffUnits(before, { ...before, retail: ['ou-3', 'ou-2'] })).toEqual([]);
  });
});

describe('touchesArea', () => {
  it('is true only when the change affects that area', () => {
    const after = { ...before, retail: ['ou-2'] };
    expect(touchesArea(before, after, 'retail')).toBe(true);
    expect(touchesArea(before, after, 'finanzas')).toBe(false);
    expect(touchesArea(before, after, null)).toBe(false);
  });
});

// ADM-02: area names that collide with Object.prototype members must be plain data.
describe('prototype-named areas', () => {
  const PROTO_NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];

  function mapping(entries: Record<string, string[]>): Units {
    // JSON.parse defines own properties, even for "__proto__" (like an API response does).
    return JSON.parse(JSON.stringify(entries)) as Units;
  }

  it('diffs areas named like Object.prototype members without crashing', () => {
    const before = mapping({ retail: ['ou-2'] });
    const after = JSON.parse(
      '{"retail":["ou-2"],"constructor":["ou-3"],"__proto__":["ou-4"],"toString":["ou-5"],"hasOwnProperty":["ou-6"]}',
    ) as Units;
    const diffs = diffUnits(before, after);
    expect(diffs.map((diff) => diff.area).sort()).toEqual([...PROTO_NAMES].sort());
    for (const diff of diffs) {
      expect(diff.kind).toBe('added');
      expect(diff.removed).toEqual([]);
    }
  });

  it('handles those areas in the current mapping, removed and changed', () => {
    const before = JSON.parse(
      '{"constructor":["ou-1"],"__proto__":["ou-2"],"toString":["ou-3"],"hasOwnProperty":["ou-4"]}',
    ) as Units;
    const after = JSON.parse('{"constructor":["ou-1","ou-9"],"toString":["ou-3"]}') as Units;
    expect(diffUnits(before, after)).toEqual([
      { area: '__proto__', kind: 'removed', added: [], removed: ['ou-2'] },
      { area: 'constructor', kind: 'changed', added: ['ou-9'], removed: [] },
      { area: 'hasOwnProperty', kind: 'removed', added: [], removed: ['ou-4'] },
    ]);
    expect(diffUnits(before, before)).toEqual([]);
    expect(touchesArea(before, after, 'constructor')).toBe(true);
    expect(touchesArea(before, after, 'toString')).toBe(false);
  });

  it('reads only own OU lists', () => {
    for (const name of PROTO_NAMES) expect(ousOf({}, name)).toEqual([]);
    expect(ousOf(mapping({ constructor: ['ou-1'] }), 'constructor')).toEqual(['ou-1']);
  });

  it('round-trips through a Map without touching the prototype', () => {
    const units = JSON.parse('{"__proto__":["ou-1"],"constructor":["ou-2"]}') as Units;
    const back = mapToUnits(unitsToMap(units));
    expect(Object.keys(back).sort()).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('ouTree', () => {
  it('orders parents before children with their depth and breadcrumb', () => {
    const nodes = ouTree([
      { id: 'ou-a-2', name: 'Finanzas', parent_id: 'ou-a-1', path: ['Workloads', 'Finanzas'] },
      { id: 'ou-a-1', name: 'Workloads', parent_id: 'r-a', path: ['Workloads'] },
      { id: 'ou-a-3', name: 'Sandbox', parent_id: 'r-a', path: ['Sandbox'] },
    ]);
    expect(nodes.map((node) => [node.id, node.depth, node.label])).toEqual([
      ['ou-a-1', 0, 'Workloads'],
      ['ou-a-2', 1, 'Workloads › Finanzas'],
      ['ou-a-3', 0, 'Sandbox'],
    ]);
  });

  it('never loops on cyclic parents and keeps every OU', () => {
    const nodes = ouTree([
      { id: 'ou-a-1', name: 'A', parent_id: 'ou-a-2', path: ['A'] },
      { id: 'ou-a-2', name: 'B', parent_id: 'ou-a-1', path: ['B'] },
    ]);
    expect(nodes.map((node) => node.id).sort()).toEqual(['ou-a-1', 'ou-a-2']);
  });
});

describe('pending changes', () => {
  const change = {
    change_id: 'c1',
    proposed_by: 'admin-2',
    proposed_by_email: null,
    created_at: '2026-09-29T10:00:00Z',
    expires_at: '2026-10-06T10:00:00Z',
    base_version: 1,
    units: {},
    reason: 'x',
  };

  it('is expired from expires_at on (and when the date is unreadable)', () => {
    expect(isExpired(change, Date.parse('2026-10-06T09:59:59Z'))).toBe(false);
    expect(isExpired(change, Date.parse('2026-10-06T10:00:00Z'))).toBe(true);
    expect(isExpired({ ...change, expires_at: 'nope' })).toBe(true);
  });

  it('names the proposer by email, else by id', () => {
    expect(proposerOf(change)).toBe('admin-2');
    expect(proposerOf({ ...change, proposed_by_email: 'a@example.com' })).toBe('a@example.com');
  });
});
