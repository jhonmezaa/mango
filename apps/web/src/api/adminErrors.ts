import { ApiError, NotAuthenticatedError } from './errors';

export type AdminErrorKey =
  | 'admin.errors.self_edit'
  | 'admin.errors.same_approver'
  | 'admin.errors.version_conflict'
  | 'admin.errors.expired'
  | 'admin.errors.unknown_ou'
  | 'admin.errors.too_many_pending'
  | 'admin.errors.audit_unavailable'
  | 'admin.errors.rate_limited'
  | 'admin.errors.unavailable'
  | 'admin.errors.forbidden'
  | 'admin.errors.invalid'
  | 'admin.errors.network'
  | 'admin.errors.generic';

const BY_CODE: Record<string, AdminErrorKey> = {
  self_edit: 'admin.errors.self_edit',
  same_approver: 'admin.errors.same_approver',
  version_conflict: 'admin.errors.version_conflict',
  expired: 'admin.errors.expired',
  unknown_ou: 'admin.errors.unknown_ou',
  too_many_pending: 'admin.errors.too_many_pending',
  audit_unavailable: 'admin.errors.audit_unavailable',
  rate_limited: 'admin.errors.rate_limited',
};

/**
 * Maps an admin API failure to a localized message key. The server's `message` is never shown
 * raw: the specific code wins, then the HTTP status.
 */
export function adminErrorKey(error: unknown): AdminErrorKey {
  if (error instanceof ApiError) {
    const known = BY_CODE[error.code];
    if (known) return known;
    if (error.status === 409) return 'admin.errors.version_conflict';
    if (error.status === 410) return 'admin.errors.expired';
    if (error.status === 429) return 'admin.errors.rate_limited';
    if (error.status === 403) return 'admin.errors.forbidden';
    // A bare 503 comes from the load balancer or CDN (no healthy API), not from the audit write:
    // only the `audit_unavailable` code means the audit could not be recorded.
    if (error.status === 503) return 'admin.errors.unavailable';
    if (error.status === 400 || error.status === 422) return 'admin.errors.invalid';
    return 'admin.errors.generic';
  }
  if (error instanceof NotAuthenticatedError) return 'admin.errors.generic';
  if (error instanceof TypeError) return 'admin.errors.network';
  return 'admin.errors.generic';
}

/** Failures that mean "the data on screen is stale": the page must reload it. */
export function isStaleDataError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 410 || (error.status === 409 && error.code !== 'too_many_pending'))
  );
}

/** Code of an API failure (e.g. `rate_limited`), or null for network and client errors. */
export function apiErrorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}
