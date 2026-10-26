import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/errors';
import { agentFixture } from '../../test/fixtures';
import { context, definition } from '../agentBuilder/testFixtures';
import {
  applyEvent,
  blockOfError,
  blockOfEvent,
  draftSources,
  formatCost,
  formatSeconds,
  publishedSources,
  testModels,
  withChanges,
  type Entry,
  type MineItem,
} from './model';

function mine(overrides: Partial<MineItem>): MineItem {
  return {
    agent_id: 'k3fq7zr2m5xw6n4a',
    version: 2,
    revision: 4,
    status: 'draft',
    base_version: 1,
    name: 'Savings Plans',
    description: '',
    category: 'FinOps',
    icon: 'Money',
    color: 1,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    submitted_at: null,
    rejected_at: null,
    rejection_reason: null,
    failed_step: null,
    ...overrides,
  };
}

const entry = (): Entry => ({
  key: 'e1',
  column: { label: null, version: 1, revision: 1, model: 'model.main', overrides: {} },
  state: 'running',
  text: '',
  tools: [],
  writes: [],
  done: null,
});

describe('sources', () => {
  it('lists only drafts of the caller, rejected ones with their reason', () => {
    const sources = draftSources([
      mine({}),
      mine({ agent_id: 'b6t2hd5yq7lc3vpe', status: 'in_review' }),
      mine({ agent_id: 'd7vm3a5txo2r6ifb', version: 1, rejection_reason: 'Falta el rol.' }),
    ]);
    expect(sources.map((source) => source.key)).toEqual([
      'draft:k3fq7zr2m5xw6n4a:2',
      'draft:d7vm3a5txo2r6ifb:1',
    ]);
    expect(sources[1]?.rejection).toBe('Falta el rol.');
  });

  it('lists the published agents an admin edits, or the caller created', () => {
    const items = [
      agentFixture({ id: 'finops', is_mine: false }),
      agentFixture({ id: 'mine', is_mine: true }),
      agentFixture({ id: 'gone', is_mine: true, status: 'retired' }),
    ];
    expect(publishedSources(items, true).map((source) => source.agentId)).toEqual([
      'finops',
      'mine',
    ]);
    expect(publishedSources(items, false).map((source) => source.agentId)).toEqual(['mine']);
  });
});

describe('testModels and withChanges', () => {
  it('offers only models that call tools when the version has tools or knowledge bases', () => {
    const ids = (d = definition()) => testModels(context.models, d).map((model) => model.id);
    expect(ids()).toEqual(['model.main', 'model.fast']);
    expect(ids(definition({ tools: [], knowledge_bases: ['kb1'] }))).toEqual([
      'model.main',
      'model.fast',
    ]);
    expect(ids(definition({ tools: [] }))).toEqual(['model.main', 'model.fast', 'model.text']);
  });

  it('adds a new model to the allowed ones', () => {
    const changed = withChanges(definition(), 'Otro prompt', 'model.fast');
    expect(changed.system_prompt).toBe('Otro prompt');
    expect(changed.model).toBe('model.fast');
    expect(changed.allowed_models).toEqual(['model.main', 'model.fast']);
  });
});

describe('applyEvent', () => {
  it('times each tool between its start and its end', () => {
    let current = applyEvent(entry(), { type: 'tool', name: 'a', status: 'started' }, 1000);
    current = applyEvent(current, { type: 'tool', name: 'a', status: 'completed' }, 3100);
    expect(current.tools).toEqual([{ name: 'a', status: 'completed', ms: 2100, startedAt: 1000 }]);
    expect(formatSeconds(current.tools[0]?.ms ?? 0)).toBe('2,1');
  });

  it('shows a write call once, as the write it would ask for', () => {
    let current = applyEvent(entry(), { type: 'tool', name: 'stop', status: 'started' }, 0);
    current = applyEvent(current, { type: 'simulated_write', tool: 'stop' }, 10);
    current = applyEvent(current, { type: 'simulated_write', tool: 'stop' }, 20);
    expect(current.tools).toEqual([]);
    expect(current.writes).toEqual(['stop']);
  });

  it('appends text and ends with done or error', () => {
    let current = applyEvent(entry(), { type: 'delta', text: 'Ho' }, 0);
    current = applyEvent(current, { type: 'delta', text: 'la' }, 0);
    expect(current.text).toBe('Hola');
    expect(applyEvent(current, { type: 'error', code: 'upstream_error' }, 0).state).toBe('error');
  });
});

describe('blocks', () => {
  it('maps the answers that stop every test', () => {
    const now = 1_000;
    const of = (status: number, code: string, retryAfter: number | null = null) =>
      blockOfError(new ApiError(status, code, 'x', retryAfter), now);
    expect(of(429, 'rate_limited', 42)).toEqual({ kind: 'rate', until: 43_000 });
    expect(of(429, 'playground_busy', 5)).toEqual({ kind: 'rate', until: 6_000 });
    expect(of(503, 'playground_unavailable')).toEqual({ kind: 'unavailable' });
    expect(of(409, 'model_unavailable')).toEqual({ kind: 'model', reason: 'off' });
    expect(of(422, 'model_without_tools')).toEqual({ kind: 'model', reason: 'noTools' });
    expect(of(409, 'version_not_testable')).toEqual({ kind: 'notTestable' });
    expect(of(422, 'skill_unavailable')).toEqual({ kind: 'skill' });
    expect(of(503, 'skills_unavailable')).toEqual({ kind: 'skills' });
    expect(of(409, 'agent_retired')).toEqual({ kind: 'retired' });
    expect(of(409, 'version_conflict')).toBeNull();
    expect(blockOfError(new Error('x'), now)).toBeNull();
  });

  it('says whose budget ran out', () => {
    expect(blockOfEvent({ type: 'error', code: 'budget_exceeded', scope: 'agent' })).toEqual({
      kind: 'budgetAgent',
    });
    expect(blockOfEvent({ type: 'error', code: 'budget_exceeded', scope: 'user' })).toEqual({
      kind: 'budgetUser',
    });
    expect(blockOfEvent({ type: 'error', code: 'upstream_error' })).toBeNull();
  });

  it('formats cost with a comma, as the design', () => {
    expect(formatCost('0.0123')).toBe('0,0123');
  });
});
