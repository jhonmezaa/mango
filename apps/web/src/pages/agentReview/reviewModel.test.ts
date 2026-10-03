import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/errors';
import {
  AGENT_ICONS,
  isForbidden,
  isStale,
  otherChanges,
  decidedAt,
  historyStatus,
  pastReviews,
  pendingReviews,
  reasonOf,
  reviewerOf,
  reviewErrorKey,
  toolIndex,
  type Diff,
  type Review,
} from './reviewModel';

function review(overrides: Partial<Review>): Review {
  return {
    agent_id: 'b6t2hd5yq7lc3vpe',
    version: 1,
    status: 'in_review',
    kind: 'new',
    name: 'Agente',
    description: '',
    category: '',
    icon: 'Bot',
    color: 0,
    content_hash: 'a'.repeat(64),
    created_by: 'admin-2',
    created_by_email: null,
    submitted_at: '2026-10-01T10:00:00Z',
    approved_by: null,
    approved_by_email: null,
    approved_at: null,
    published_at: null,
    failed_step: null,
    rejected_by: null,
    rejected_by_email: null,
    rejected_at: null,
    rejection_reason: null,
    retired_by: null,
    retired_by_email: null,
    retired_at: null,
    retire_reason: null,
    decided_at: null,
    retryable: false,
    changes: 0,
    is_author: false,
    ...overrides,
  };
}

describe('reviewModel', () => {
  it('queues what is in review and what is being published, the oldest first', () => {
    const reviews = {
      queue: [review({ agent_id: 'late', submitted_at: '2026-10-01T12:00:00Z' })],
      history: [
        review({ agent_id: 'done', status: 'published' }),
        review({
          agent_id: 'publishing',
          status: 'approved',
          submitted_at: '2026-10-01T09:00:00Z',
        }),
        review({ agent_id: 'broken', status: 'failed' }),
        // Approved long ago and never published: no longer "Publicando…".
        review({ agent_id: 'stuck', status: 'approved', retryable: true }),
      ],
    };
    expect(pendingReviews(reviews).map((item) => item.agent_id)).toEqual(['publishing', 'late']);
    expect(pastReviews(reviews).map((item) => item.agent_id)).toEqual(['done', 'broken', 'stuck']);
  });

  it('names the status, the reviewer and the reason of a history row', () => {
    const rejected = review({
      status: 'draft',
      rejected_by: 'admin-9',
      rejected_by_email: 'r@example.com',
      rejection_reason: 'Falta el alcance',
      approved_by: 'admin-1',
    });
    expect([historyStatus(rejected), reviewerOf(rejected), reasonOf(rejected)]).toEqual([
      'rejected',
      { who: 'r@example.com', internal: false },
      'Falta el alcance',
    ]);
    const retired = review({
      status: 'retired',
      approved_by: 'admin-1',
      retired_by: 'admin-3',
      retire_reason: 'Duplicado',
    });
    expect([historyStatus(retired), reviewerOf(retired), reasonOf(retired)]).toEqual([
      'retired',
      // A decision without an email: the internal identifier, said as such.
      { who: 'admin-3', internal: true },
      'Duplicado',
    ]);
    const published = review({
      status: 'published',
      approved_by: 'admin-1',
      approved_by_email: 'a@example.com',
      // Left over from an earlier rejection of the same version: not this row's reason.
      rejection_reason: null,
    });
    expect([historyStatus(published), reviewerOf(published), reasonOf(published)]).toEqual([
      'published',
      { who: 'a@example.com', internal: false },
      null,
    ]);
    expect(reviewerOf(review({ status: 'published' }))).toBeNull();
    expect(historyStatus(review({ status: 'approved', retryable: true }))).toBe('failed');
    expect(historyStatus(review({ status: 'draft' }))).toBe('draft');
    expect(decidedAt(review({ decided_at: '2026-10-01T11:00:00Z' }))).toBe('2026-10-01T11:00:00Z');
  });

  it('maps API failures to messages without showing the server text', () => {
    expect(reviewErrorKey(new ApiError(403, 'same_approver', 'x'))).toBe(
      'agentReview.errors.same_approver',
    );
    expect(reviewErrorKey(new ApiError(409, 'anything', 'x'))).toBe(
      'agentReview.errors.version_conflict',
    );
    expect(reviewErrorKey(new ApiError(503, 'provisioner_unavailable', 'x'))).toBe(
      'agentReview.errors.provisioner_unavailable',
    );
    expect(reviewErrorKey(new ApiError(503, 'groups_unavailable', 'x'))).toBe(
      'agentReview.errors.rules_unavailable',
    );
    expect(reviewErrorKey(new ApiError(403, 'forbidden', 'x'))).toBe(
      'agentReview.errors.forbidden',
    );
    // A code that happens to be a property of every object is not a known code.
    expect(reviewErrorKey(new ApiError(500, 'constructor', 'x'))).toBe(
      'agentReview.errors.generic',
    );
    expect(reviewErrorKey(new TypeError('failed to fetch'))).toBe('agentReview.errors.network');
  });

  it('reloads after a conflict or a failed rule, and tells "forbidden" from "same approver"', () => {
    expect(isStale(new ApiError(409, 'version_conflict', 'x'))).toBe(true);
    expect(isStale(new ApiError(422, 'validation_failed', 'x'))).toBe(true);
    expect(isStale(new ApiError(503, 'audit_unavailable', 'x'))).toBe(false);
    expect(isForbidden(new ApiError(403, 'forbidden', 'x'))).toBe(true);
    expect(isForbidden(new ApiError(403, 'same_approver', 'x'))).toBe(false);
  });

  it('keeps changes the screen has no section for', () => {
    const diff: Diff = {
      is_new: false,
      changes: 3,
      prompt: null,
      fields: [
        { field: 'name', before: 'A', after: 'B' },
        { field: 'memory', before: null, after: 'long' },
      ],
      sets: [
        { field: 'tools', added: ['x.y'], removed: [] },
        { field: 'skills', added: ['s'], removed: [] },
      ],
    };
    expect(otherChanges(diff)).toEqual({
      fields: [{ field: 'memory', before: null, after: 'long' }],
      sets: [{ field: 'skills', added: ['s'], removed: [] }],
    });
  });

  it('only knows the icons it lists', () => {
    expect(AGENT_ICONS['Money']).toBeDefined();
    expect(AGENT_ICONS['constructor']).toBeUndefined();
    expect(AGENT_ICONS['__proto__']).toBeUndefined();
  });

  it('indexes the tools of the catalog with the data tier of their connector', () => {
    const tools = toolIndex({
      max_enabled_packs: 10,
      items: [
        {
          id: 'pack',
          kind: 'pack',
          name: 'Pack',
          description: '',
          provider: 'AWS',
          data_tier: 'write',
          identity_mode: 'service',
          enabled: false,
          permissions: [],
          agents: [],
          tools: [
            {
              ref: 'pack.stop',
              name: 'stop',
              description: '',
              access: 'write',
              audience: 'central',
              central_groups_only: true,
              enabled: true,
            },
          ],
        },
      ],
    });
    expect(tools.get('pack.stop')).toEqual({ dataTier: 'write', write: true, enabled: false });
  });
});
