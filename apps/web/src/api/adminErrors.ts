import type { TFunction } from 'i18next';

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

const clock = new Intl.DateTimeFormat('es-MX', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * When a request refused with a 429 may be sent again, in words (design round 34): «en unos
 * segundos», «en N minutos», «a las HH:MM» today, «mañana a las HH:MM» on another day; «en unos
 * minutos» when the answer did not say. Only the 429 has it; anything else gets ''.
 */
export function rateWhen(error: unknown, t: TFunction, now: Date = new Date()): string {
  if (!(error instanceof ApiError) || error.status !== 429) return '';
  const seconds = error.retryAfter;
  if (seconds === null) return t('admin.rateWhen.unknown');
  if (seconds < 60) return t('admin.rateWhen.seconds');
  if (seconds < 3600) return t('admin.rateWhen.minutes', { count: Math.ceil(seconds / 60) });
  const at = new Date(now.getTime() + seconds * 1000);
  const time = clock.format(at);
  return at.toDateString() === now.toDateString()
    ? t('admin.rateWhen.today', { time })
    : t('admin.rateWhen.tomorrow', { time });
}

/** The text of an admin API failure: `adminErrorKey`, with the wait of a 429 in it. */
export function adminErrorText(t: TFunction, error: unknown): string {
  return t(adminErrorKey(error), { when: rateWhen(error, t) });
}
