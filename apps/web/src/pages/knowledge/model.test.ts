import { describe, expect, it } from 'vitest';

import {
  NO_FILTERS,
  filtered,
  formatBytes,
  formatCount,
  formatEstimate,
  locationError,
  partialAgents,
  sameGroups,
  shownLocation,
  shownStatus,
  statusKey,
} from './model';
import { SRC_ID, bucketKb, kb } from './testFixtures';

describe('shownStatus', () => {
  it('follows the stored status of a knowledge base of files', () => {
    expect(shownStatus(kb())).toBe('ok');
    expect(shownStatus(kb({ status: 'warn' }))).toBe('warn');
    expect(shownStatus(kb({ status: 'pending' }))).toBe('pending');
  });

  it('puts deleting and synchronizing before anything else', () => {
    expect(shownStatus(kb({ status: 'deleting', sync_running: true }))).toBe('deleting');
    expect(shownStatus(kb({ sync_running: true, status_reason: 'budget' }))).toBe('syncing');
    expect(shownStatus(bucketKb({ status: 'syncing', sources: [] }))).toBe('syncing');
  });

  it('reads the sources of a bucket: approval, rejected or without a bucket', () => {
    const pending = { src_id: SRC_ID, status: 'pending', location: null } as const;
    const rejected = { ...pending, status: 'rejected' } as const;
    const withdrawn = { ...pending, status: 'withdrawn' } as const;
    expect(shownStatus(bucketKb({ status: 'pending', sources: [pending] }))).toBe('approval');
    expect(shownStatus(bucketKb({ status: 'pending', sources: [rejected] }))).toBe('rejected');
    expect(shownStatus(bucketKb({ status: 'pending', sources: [withdrawn] }))).toBe('nosource');
    expect(shownStatus(bucketKb({ status: 'pending', sources: [] }))).toBe('nosource');
    // A change waiting while the approved bucket keeps synchronizing.
    const approved = { ...pending, status: 'approved' } as const;
    expect(shownStatus(bucketKb({ sources: [approved, pending] }))).toBe('ok');
    // Sources that could not be read say nothing: the stored status stays.
    expect(shownStatus(bucketKb({ sources: null }))).toBe('ok');
  });

  it('says why the last synchronization did not finish (D88 (43))', () => {
    expect(shownStatus(bucketKb({ status_reason: 'budget' }))).toBe('blocked');
    expect(shownStatus(bucketKb({ status_reason: 'full' }))).toBe('full');
    expect(shownStatus(bucketKb({ status: 'error', status_reason: 'error' }))).toBe('error');
  });
});

describe('statusKey', () => {
  it('never says «synchronized» of uploaded files', () => {
    expect(statusKey(kb())).toBe('okUpload');
    expect(statusKey(kb({ sync_running: true }))).toBe('syncingUpload');
    expect(statusKey(kb({ status: 'pending' }))).toBe('pendingUpload');
    expect(statusKey(kb({ status: 'warn' }))).toBe('warn');
    expect(statusKey(bucketKb())).toBe('ok');
  });
});

describe('filtered', () => {
  const items = [
    kb(),
    bucketKb({ status_reason: 'full' }),
    bucketKb({ kb_id: 'x', name: 'Legal', status: 'pending', sources: [] }),
  ];

  it('filters by attention, unsynced, origin and text', () => {
    expect(filtered(items, { ...NO_FILTERS, status: 'attention' }).map((k) => k.name)).toEqual([
      'AWS Runbooks',
      'Legal',
    ]);
    expect(filtered(items, { ...NO_FILTERS, status: 'unsynced' })).toEqual([]);
    expect(filtered(items, { ...NO_FILTERS, origin: 'upload' }).map((k) => k.name)).toEqual([
      'Políticas de RH',
    ]);
    expect(filtered(items, { ...NO_FILTERS, query: ' beneficios ' }).map((k) => k.name)).toEqual([
      'Políticas de RH',
    ]);
  });
});

describe('the rest', () => {
  it('names the agents with groups outside the knowledge base', () => {
    const agents = [
      { agent_id: 'a', name: 'People Docs', groups_without_access: ['mango-admin'] },
      { agent_id: 'b', name: 'FinOps', groups_without_access: [] },
      { agent_id: 'c', name: 'Otro', groups_without_access: null },
    ];
    expect(partialAgents(kb({ agents })).map((agent) => agent.name)).toEqual(['People Docs']);
  });

  it('shows the approved bucket first', () => {
    expect(shownLocation(bucketKb())).toBe('s3://empresa-runbooks/ops/');
    expect(shownLocation(kb())).toBeNull();
  });

  it('formats like the design', () => {
    expect(formatCount(1000)).toBe('1.000');
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(48_000_000)).toBe('48 MB');
    expect(formatBytes(5e9)).toBe('5 GB');
    expect(formatBytes(1500)).toBe('2 KB');
    expect(formatEstimate('12.4')).toBe('USD 12,40');
    expect(formatEstimate('x')).toBeNull();
  });

  it('checks only the shape of a location', () => {
    expect(locationError('')).toBe('ref');
    expect(locationError('bucket/prefijo')).toBe('refFormat');
    expect(locationError('s3://Bucket/')).toBe('refFormat');
    expect(locationError(' s3://empresa-runbooks/ops/ ')).toBeNull();
    expect(locationError('s3://empresa-runbooks')).toBeNull();
  });

  it('compares groups without their order', () => {
    expect(sameGroups(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameGroups(['a'], ['a', 'b'])).toBe(false);
  });
});
