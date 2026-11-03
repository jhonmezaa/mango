import { describe, expect, it } from 'vitest';

import i18n from '../i18n';
import { adminErrorKey, adminErrorText, isStaleDataError, rateWhen } from './adminErrors';
import { ApiError, sessionUnavailableError } from './errors';

describe('adminErrorKey', () => {
  it('maps the admin error codes to specific messages', () => {
    expect(adminErrorKey(new ApiError(403, 'self_edit', 'x'))).toBe('admin.errors.self_edit');
    expect(adminErrorKey(new ApiError(403, 'same_approver', 'x'))).toBe(
      'admin.errors.same_approver',
    );
    expect(adminErrorKey(new ApiError(409, 'version_conflict', 'x'))).toBe(
      'admin.errors.version_conflict',
    );
    expect(adminErrorKey(new ApiError(410, 'expired', 'x'))).toBe('admin.errors.expired');
    expect(adminErrorKey(new ApiError(400, 'unknown_ou', 'x'))).toBe('admin.errors.unknown_ou');
    expect(adminErrorKey(new ApiError(429, 'rate_limited', 'x'))).toBe('admin.errors.rate_limited');
    expect(adminErrorKey(new ApiError(409, 'too_many_pending', 'x'))).toBe(
      'admin.errors.too_many_pending',
    );
    expect(adminErrorKey(new ApiError(503, 'audit_unavailable', 'x'))).toBe(
      'admin.errors.audit_unavailable',
    );
  });

  it('falls back on the HTTP status, and never shows the server message', () => {
    expect(adminErrorKey(new ApiError(403, 'forbidden', '<b>raw</b>'))).toBe(
      'admin.errors.forbidden',
    );
    expect(adminErrorKey(new ApiError(409, 'other', 'x'))).toBe('admin.errors.version_conflict');
    expect(adminErrorKey(new ApiError(429, 'http_429', 'x'))).toBe('admin.errors.rate_limited');
    expect(adminErrorKey(new ApiError(422, 'invalid_request', 'x'))).toBe('admin.errors.invalid');
    expect(adminErrorKey(new ApiError(500, 'boom', 'x'))).toBe('admin.errors.generic');
    // A 503 without the audit code (load balancer, CDN) is not reported as an audit failure.
    expect(adminErrorKey(new ApiError(503, 'http_503', 'x'))).toBe('admin.errors.unavailable');
    expect(adminErrorKey(new TypeError('Failed to fetch'))).toBe('admin.errors.network');
  });

  it('shows a session renewal that did not answer like any other outage or limit', () => {
    expect(adminErrorKey(sessionUnavailableError())).toBe('admin.errors.unavailable');
    expect(adminErrorKey(sessionUnavailableError({ rateLimited: true }))).toBe(
      'admin.errors.rate_limited',
    );
  });

  it('has a Spanish message for every key', () => {
    for (const code of [
      'self_edit',
      'same_approver',
      'version_conflict',
      'expired',
      'unknown_ou',
      'too_many_pending',
      'audit_unavailable',
    ]) {
      const key = adminErrorKey(new ApiError(400, code, 'x'));
      expect(i18n.t(key)).not.toBe(key);
    }
  });

  it('flags 409 and 410 as stale data', () => {
    expect(isStaleDataError(new ApiError(409, 'version_conflict', 'x'))).toBe(true);
    expect(isStaleDataError(new ApiError(410, 'expired', 'x'))).toBe(true);
    expect(isStaleDataError(new ApiError(403, 'self_edit', 'x'))).toBe(false);
    // Too many pending proposals is a limit, not stale data.
    expect(isStaleDataError(new ApiError(409, 'too_many_pending', 'x'))).toBe(false);
  });
});

describe('rateWhen · design round 34', () => {
  const t = i18n.t.bind(i18n);
  const limited = (seconds: number | null) =>
    new ApiError(429, 'rate_limited', 'too many requests', seconds);
  const now = new Date(2026, 10, 2, 9, 0, 0);

  it('says when a 429 lifts, from its Retry-After', () => {
    expect(rateWhen(limited(20), t, now)).toBe('en unos segundos');
    expect(rateWhen(limited(60), t, now)).toBe('en 1 minuto');
    expect(rateWhen(limited(150), t, now)).toBe('en 3 minutos');
    expect(rateWhen(limited(2 * 3600), t, now)).toBe('a las 11:00');
    expect(rateWhen(limited(20 * 3600), t, now)).toBe('mañana a las 05:00');
    expect(rateWhen(limited(null), t, now)).toBe('en unos minutos');
    expect(rateWhen(new ApiError(503, 'unavailable', 'x'), t, now)).toBe('');
  });

  it('puts it in the admin text, which no longer says «Espera un minuto»', () => {
    expect(adminErrorText(t, limited(150))).toBe(
      'Hiciste demasiadas solicitudes. Puedes volver a intentarlo en 3 minutos.',
    );
    expect(adminErrorText(t, new ApiError(403, 'forbidden', 'x'))).toBe(
      t('admin.errors.forbidden'),
    );
  });
});
