import type { Suite } from './model';

/** A suite as GET /api/evals returns it, for tests. */
export function suite(overrides: Partial<Suite> = {}): Suite {
  return {
    suite_id: 'b'.repeat(32),
    agent_id: 'finops',
    name: 'Golden',
    description: '',
    kind: 'golden',
    required: true,
    threshold: 80,
    trigger: 'manual',
    judge_model: null,
    case_count: 2,
    revision: 1,
    created_by_email: null,
    updated_at: '2026-11-05T12:00:00Z',
    request: null,
    last_run: null,
    active_run: null,
    last_attempt: null,
    recent_scores: [],
    completed_runs: 0,
    can_edit: true,
    ...overrides,
  };
}
